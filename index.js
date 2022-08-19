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
const repoListString = core.getInput("repo");
const repoList = repoListString.split(",");

async function writeToS3(response, fileName, path) {
  try {
    // writing tarball to file
    const writeStream = fs.createWriteStream(fileName);

    response.pipe(writeStream).on("finish", async function () {
      writeStream.close();
      // getting downloaded tarfile to send to s3 bucket
      const fileData = fs.readFileSync(fileName);

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
async function listDependenciesS3(path) {
  const params = {
    Bucket: bucketName,
    Prefix: path + "/",
  };
  try {
    // gets all objects in the bucket folder specified by path
    const data = await client.send(new ListObjectsCommand(params));
    if (data.length < 0) {
      return data;
    }

    // gets files that have .gz in file name sorted by last modified date desc
    const files = data.Contents?.filter((file) => {
      return file.Key.includes(".gz");
    }).sort((file1, file2) => file2.LastModified - file1.LastModified);

    return files;
  } catch (err) {
    console.log(err);
    throw err;
  }
}
async function updateDependencies(fileName, tag_name, repo, owner) {
  // download location of the tarfile of a repo for a specific release
  const TAR_URL = `https://api.github.com/repos/${owner}/${repo}/tarball/${tag_name}`;

  // path where to store tar file on s3 bucket
  const path = "Dependencies/" + repo + "/" + fileName;

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
            writeToS3(response, fileName, path);
          });
        } else {
          https.get(
            url.resolve(url.parse(TAR_URL).hostname, response.headers.location),
            (response) => {
              writeToS3(response, fileName, path);
            }
          );
        }
      } else {
        writeToS3(response, fileName, path);
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
  let v1Split = v1.split(".");
  let v2Split = v2.split(".");
  if (v1Split.length == v2Split.length) {
    for (let i = 0; i < v1Split.length; i++) {
      if (v1Split[i] > v2Split[i]) {
        return 1;
      }
      if (v1Split[i] < v2Split[i]) {
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

    const pathAndOrg = parseConfig(cfg);
    if (pathAndOrg.length == 0) {
      console.log("Could not parse config file");
      return;
    }
    const owner = pathAndOrg[1];
    const path = pathAndOrg[0];

    // get latest versions of tar file on s3 bucket
    const s3DeplList = await listDependenciesS3(path);

    // gets latest version of the repo on Github
    const ghLatestRelease = await getLatest(repo, owner);

    if (ghLatestRelease == null) {
      console.log("Could not fetch latest release on Github");
      return;
    }

    // remove the v and leave just the version number
    const gTag = ghLatestRelease.data.tag_name.replace("v", "");

    // if there are no versions stored on the s3 bucket of this repo
    if (!s3DeplList) {
      updateDependencies(
        repo + "-" + gTag + ".tar.gz",
        ghLatestRelease.data.tag_name,
        repo,
        owner
      );
      return;
    }

    // s3Latest is sorted descending alphabetically so the first element will give the latest version in s3 bucket
    const s3Latest = s3DeplList[0];

    // geting version number of latest tar file stored in s3 bucket
    const s3LatestTag = s3Latest.Key.substring(
      s3Latest.Key.indexOf("-") + 1,
      s3Latest.Key.indexOf(".tar")
    );

    console.log("Latest Version on S3: " + s3LatestTag);
    console.log("Latest Version on Github: " + gTag);

    // if version on Github is newer than one stored on s3, update depenendency
    if (compareVersions(gTag, s3LatestTag)) {
      console.log("Updating Dependency");
      updateDependencies(
        repo + "-" + gTag + ".tar.gz",
        ghLatestRelease.data.tag_name,
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

repoList.forEach((element) => {
  syncDependencies(element);
});
