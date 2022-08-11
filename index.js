const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");
const {
  S3Client,
  ListObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const { Octokit, App } = require("octokit");
const exec = require("@actions/exec");

var bucketName = core.getInput("bucketName");
let client = new S3Client();
let octokit = new Octokit({ auth: core.getInput("token") });
var depPath = core.getInput("depPath");
var repo = core.getInput("repo");
var owner = core.getInput("owner");
var main_branch = core.getInput("main_branch");

// opens folder where dependency configs are stored
const dir = fs.opendirSync(depPath);

async function getMainRef() {
  // create ref of the main branch
  try {
    var ref = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: owner,
      repo: repo,
      ref: "heads/" + main_branch,
    });
  } catch {
    console.log(err);
    throw err;
  }
  return ref;
}

async function createRef(hash, branchName) {
  // creating a new branch with name: branchName
  // based on hash taken from the branch we want the new one to be based on
  try {
    console.log("creating ref");
    var res = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: owner,
      repo: repo,
      ref: "refs/heads/" + branchName,
      sha: hash,
    });
  } catch {
    console.log(err);
    throw err;
  }
  return res;
}

async function createBranch(branchName) {
  try {
    // get ref of branch we want the new branch to be based on
    var ref = await getMainRef();

    var hash = ref.data.object.sha;

    // pass in the hash
    var res = await createRef(hash, branchName);
  } catch (err) {
    console.log(err);
    throw err;
  }
}

async function listDependenciesS3(path) {
  var params = {
    Bucket: bucketName,
    Prefix: path + "/",
  };

  // gets all objects in the bucket specified by path
  const data = await client.send(new ListObjectsCommand(params));
  if (data.length < 0) {
    return data;
  }

  // gets all the file names that end with the file extension .gz and sorts them by LastModified Desc
  // result is an array with the most recent versions of the tar files coming first
  var files = data.Contents?.filter((file) => {
    file.Key.includes(".gz");
  }).sort((file1, file2) => file2.LastModified - file1.LastModified);

  return files;
}

async function generateHash(key) {
  var params = {
    Bucket: bucketName,
    Key: key,
  };
  try {
    // Create a helper function to convert a ReadableStream to a string.
    const streamToString = (stream) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });

    // Get the object} from the Amazon S3 bucket. It is returned as a ReadableStream.
    const data = await client.send(new GetObjectCommand(params));

    // Convert the ReadableStream to a string.
    const bodyContents = await streamToString(data.Body);

    var crypto = require("crypto");

    // creating hash object
    var hash = crypto.createHash("sha512");

    // passing the data to be hashed
    hash_data = hash.update(bodyContents, "utf-8");

    // Creating the hash in the required format
    gen_hash = hash_data.digest("hex");
    return gen_hash;
  } catch (err) {
    console.log("Error", err);
    throw err;
  }
}

async function getLastModified(key) {
  var params = {
    Bucket: bucketName,
    Key: key,
  };
  // getting last modified time of an object in s3 bucket
  const data = await client.send(new HeadObjectCommand(params));
  return data.LastModified;
}

async function existsPR() {
  var res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner: owner,
    repo: repo,
  });
  // checking if a pull request with "Automated Config Update" as the title exists
  return (
    res.data.filter((e) => e.title === "Automated Config Update").length > 0
  );
}

async function deleteBranch(branchName) {
  try {
    return await octokit.request(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      {
        owner: owner,
        repo: repo,
        ref: "heads/" + branchName,
      }
    );
  } catch {
    console.log(err);
    throw err;
  }
}

async function getBranches() {
  try {
    var res = await octokit.request("GET /repos/{owner}/{repo}/branches", {
      owner: owner,
      repo: repo,
    });
    return res.data.filter((e) => e.name.includes("AutomatedConfigUpdate"));
  } catch {
    console.log(err);
    throw err;
  }
}

async function cleanUpBranches() {
  var branchList = await getBranches();
  branchList.forEach((branch) => {
    deleteBranch(branch.name);
  });
}

async function updateConfig() {
  try {
    var exists_PR = await existsPR();

    // if a pull request exists, exit early
    if (exists_PR) {
      console.log("A Pull Request Already Exists");

      return;
    }
    console.log("Cleaning Up Branches");
    await cleanUpBranches();

    // generate new branch name with current time
    var branchName = "AutomatedConfigUpdate_" + new Date().getTime().toString();

    // create new branch
    await createBranch(branchName);

    // fetch changes
    await exec.exec("git", ["fetch"]);

    // checkout created branch
    console.log("checking out Code");
    await exec.exec("git", ["checkout", branchName]);

    let dirent;

    // reading all the files in folder where dependency configs are stored
    while ((dirent = dir.readSync()) !== null) {
      console.log(dirent.name);
      var current_repo = dirent.name.replace(".json", "");

      // opening dependency json file
      var config = JSON.parse(
        fs.readFileSync(path.join(depPath, dirent.name)),
        "utf8"
      );
      if (config["freeze"]) {
        console.log("Version Freeze Enabled Skipping Updates");
        continue;
      }

      // getting list of tar files stored on s3 sorted by version descending
      var s3_dep_list = await listDependenciesS3(
        "Dependencies/" + current_repo
      );

      // if there are no tar files stored on s3, no pull request is needed
      if (!s3_dep_list) {
        console.log("No Dependencies on S3 storage");
        continue;
      }

      // getting the newest version of the tar file
      var s3_latest = s3_dep_list[0];

      // getting the last modified time of the newest version of the tar file
      var lastModified = await getLastModified(s3_latest.Key);

      // if config has been updated before
      if (config["last_updated"] != "") {
        // get time last updated
        var last_updated = new Date(config["last_updated"]);

        // if the newest tar file was uploaded after the last time the config file was updated then config file needs to be updated
        if (lastModified > last_updated) {
          // change last updated time to current time
          config["last_updated"] = new Date().toUTCString();
        } else {
          console.log("config already up to date");
          continue;
        }
      } else {
        // config has never been updated, so last updated time must be now
        config["last_updated"] = new Date().toUTCString();
      }
      // generate hash of latest tar file stored on s3
      var hash = await generateHash(s3_latest.Key);

      console.log("hash:" + hash);
      console.log(s3_latest.Key);
      config["SHA512"] = hash;
      var version =
        "v" +
        s3_latest.Key.replace(
          "Dependencies/" + current_repo + "/" + current_repo + "-",
          ""
        ).replace(".tar.gz", "");
      config["version"] = version;

      // writing changes to file
      await fs.writeFile(
        path.join(depPath, dirent.name),
        JSON.stringify(config),
        function writeJSON(err) {
          if (err) return console.log(err);
        }
      );
    } // add changes to git
    await exec.exec("git", ["add", "."]);

    // commit changes
    await exec.exec("git", ["commit", "-m", "Automated Config Update"]);

    // push to remote origin
    await exec.exec("git", ["push"]);

    // create pull request from newly created branch to the main branch
    await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner: owner,
      repo: repo,
      title: "Automated Config Update",
      body: "Approve Changes",
      head: branchName,
      base: main_branch,
    });
  } catch (err) {
    // Commiting and Pushing Changes failed
    // Abort Creating Pull request
    // Delete newly created branch

    await deleteBranch(branchName);
  }
}
updateConfig();
