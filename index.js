const listDependenciesS3  = require( "../Utils/utils");
const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const https = require("https");
const url = require("url");
const {
  PutObjectCommand,
  S3Client,
  ListObjectsCommand,
} = require("@aws-sdk/client-s3");
const { Octokit, App } = require("octokit");

const bucketName = core.getInput("bucketName");
const client = new S3Client();
const octokit = new Octokit({ auth: core.getInput("token") });
const repo_list_string = core.getInput("repo");
const repo_list = repo_list_string.split(",");

async function writeToS3(response, FILE_NAME, path) {
  try {
    // writing tarball to file
    const writeStream = fs.createWriteStream(FILE_NAME);

    response.pipe(writeStream).on("finish", async function () {
      writeStream.close();
      // getting downloaded tarfile to send to s3 bucket
      const fileData = fs.readFileSync(FILE_NAME);

      const putParams = {
        Bucket: bucketName,
        Key: path,
        Body: fileData,
      };
        // sending to s3 bucket
      const data = await client.send(new PutObjectCommand(putParams));
      console.log("File Successfully Uploaded");
      return data;
    
    });
  } catch (err) {
    console.log(err);
    throw err;
  }
}

async function updateDependencies(FILE_NAME, tag_name, repo, owner) {
  // download location of the tarfile of a repo for a specific release
  const TAR_URL =`https://api.github.com/repos/${owner}/${repo}/tarball/${tag_name}`


  // path where to store tar file on s3 bucket
  const path = "Dependencies/" + repo + "/" + FILE_NAME;

  const options = {
    host: "api.github.com",
    path: TAR_URL,
    method: "GET",
    headers: { "user-agent": "node.js" },
  };
  console.log(TAR_URL);
  try {
    await https.get(options, (response) => {
      if (
        response.statusCode > 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        if (url.parse(response.headers.location).hostname) {
          https.get(response.headers.location, (response) => {
            writeToS3(response, FILE_NAME, path);
          });
        } else {
          https.get(
            url.resolve(url.parse(TAR_URL).hostname, response.headers.location),
            (response) => {
              writeToS3(response, FILE_NAME, path);
            }
          );
        }
      } else {
        writeToS3(response, FILE_NAME, path);
      }
    });
  } catch (err) {
    console.log(err);
    throw err;
  }
}

async function getLatest(repo, owner) {
  try {
    const latest = await octokit.request(
      "GET /repos/{owner}/{repo}/releases/latest",
      {
        owner: owner,
        repo: repo,
      }
    );
    return latest;
  } catch (err) {
    console.log(err);
    throw err;
  }
}

function compareVersions(v1, v2) {
  let v1_split = v1.split(".");
  let v2_split = v2.split(".");
  if (v1_split.length == v2_split.length) {
    for (let i = 0; i < v1_split.length; i++) {
      if (v1_split[i] > v2_split[i]) {
        return 1;
      }
      if (v1_split[i] < v2_split[i]) {
        return -1;
      }
    }
    return 0;
  } else {
    return 0;
  }
}

function getConfig(repo) {
  try {
    const depPath = core.getInput("depPath");

    // opening dependency json file
    const config = JSON.parse(fs.readFileSync(depPath, "utf8"));

    return config[repo];
  } catch (err) {
    console.log(err);
    throw err;
  }
}

function parseConfig(cfg) {
  try {
    const path = cfg["path"];
    const url = cfg["github_url"];
    const org = url.split("/")[0];
    return [path, org];
  } catch (err) {
    console.log(err);
    throw err;
  }
}

async function syncDependencies(repo) {
  try {
    // read info about repo to update from config file
    const cfg = getConfig(repo);
    if (JSON.stringify(cfg) === "{}") {
      console.log("Dependency Config is Empty");
      return;
    }

    const path_and_org = parseConfig(cfg);
    if (path_and_org.length == 0) {
      console.log("Could not parse config file");
      return;
    }
    const owner = path_and_org[1];
    const path = path_and_org[0];

    // get latest versions of tar file on s3 bucket
    const s3_dep_list = await listDependenciesS3(path);

    // gets latest version of the repo on Github
    const gh_latest_release = await getLatest(repo, owner);

    if (gh_latest_release == null) {
      console.log("Could not fetch latest release on Github");
      return;
    }

    // remove the v and leave just the version number
    const g_tag = gh_latest_release.data.tag_name.replace("v", "");

    // if there are no versions stored on the s3 bucket of this repo
    if (!s3_dep_list) {
      updateDependencies(
        repo + "-" + g_tag + ".tar.gz",
        gh_latest_release.data.tag_name,
        repo,
        owner
      );
      return;
    }

    // s3_latest is sorted descending alphabetically so the first element will give the latest version in s3 bucket
    const s3_latest = s3_dep_list[0];

    // geting version number of latest tar file stored in s3 bucket
    const s3_latest_tag = s3_latest.Key.substring(
      s3_latest.Key.indexOf("-") + 1,
      s3_latest.Key.indexOf(".tar")
    );

    console.log("Latest Version on S3: " + s3_latest_tag);
    console.log("Latest Version on Github: " + g_tag);

    // if version on Github is newer than one stored on s3, update depenendency
    if (compareVersions(g_tag, s3_latest_tag)) {
      console.log("Updating Dependency");
      updateDependencies(
        repo + "-" + g_tag + ".tar.gz",
        gh_latest_release.data.tag_name,
        repo,
        owner
      );
    } else {
      console.log("Dependency Already Up to Date");
    }
  } catch (err) {
    console.log("Encountered error, stopping action");
  }
}

repo_list.forEach((element) => {
  syncDependencies(element);
});
