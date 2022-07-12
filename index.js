
const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const https = require('https');
const url = require('url');
const { PutObjectCommand, S3Client, ListObjectsCommand } = require('@aws-sdk/client-s3')
const { Octokit, App } = require("octokit");

var bucketName = core.getInput("bucketName")
let client = new S3Client();
let octokit = new Octokit({ auth: core.getInput("token") });
var repo_list_string = core.getInput("repo")
var repo_list = repo_list_string.split(",");


async function writeToS3(response,FILE_NAME,path) {
  const writeStream = fs.createWriteStream(FILE_NAME);
  //writing tarball to file 
  response.pipe(writeStream).on("finish",async function(){
    writeStream.close()
    var fileStream = fs.createReadStream(FILE_NAME);
  // getting downloaded tarfile to send to s3 bucket 
  var putParams = {
    Bucket: bucketName,
    Key: path,
    Body: fileStream
  };
try {
   const data = await client.send(new PutObjectCommand(putParams));
    console.log("Success", data);
    return data; // For unit tests.
  } catch (err) {
    console.log("Error", err);
  }    
    //sending to s3 bucket 
    console.log("File Successfully Uploaded");
    fileStream.close()
  })
}


async function updateDep(FILE_NAME, tag_name, repo, owner) {
  console.log(FILE_NAME)
  var TAR_URL = 'https://api.github.com/repos/' + owner + '/' + repo + '/tarball/' + tag_name;
  // download location of the tarfile of a repo for a specific release 
  var path = "Dependencies/" + repo + "/" + FILE_NAME
  // path where to store tar file on s3 bucket 

  var options = {
    host: 'api.github.com',
    path: TAR_URL,
    method: 'GET',
    headers: { 'user-agent': 'node.js' }
  };
  console.log(TAR_URL)
  await https.get(options, (response) => {

    if (response.statusCode > 300 && response.statusCode < 400 && response.headers.location) {
      if (url.parse(response.headers.location).hostname) {
        https.get(response.headers.location,(response)=> {writeToS3(response,FILE_NAME,path)});
      } else {
        https.get(url.resolve(url.parse(TAR_URL).hostname, response.headers.location), (response)=> {writeToS3(response,FILE_NAME,path)});
      }
    } else {
      writeToS3(response,FILE_NAME,path);
    }
  });
  


}
async function list(path) {
  var params = {
    Bucket: bucketName,
    Prefix: path + "/",
  };

  const data = await client.send(new ListObjectsCommand(params));
  if (data.length < 0) {
    return data
  }
  //gets all objects in the bucket folder specified by path 
  var files = data.Contents?.filter((file) => { return file.Key.indexOf('.gz') > 0 }).sort((file1, file2) => -1 * file1.Key.localeCompare(file2.Key))
  //gets all the file names that end with the file extension .gz and sorts them desc alphabetically
  return files
}
async function getLatest(repo, owner) {
  var latest = await octokit.request('GET /repos/{owner}/{repo}/releases/latest', {
    owner: owner,
    repo: repo
  }


  )
  return latest
}

function compareVersions(v1, v2) {
  let v1_split = v1.split(".")
  let v2_split = v2.split(".")
  if (v1_split.length == v2_split.length) {
    for (let i = 0; i < v1_split.length; i++) {
      if (v1_split[i] > v2_split[i]) {
        return 1
      }
      if (v1_split[i] < v2_split[i]) {
        return -1
      }
    }
    return 0
  }
  else {
    return 0
  }
}

function getConfig(repo) {
  var depPath = core.getInput("depPath")
  var fs = require('fs');
  var config = JSON.parse(fs.readFileSync(depPath, 'utf8'));
  // opening dependency json file 
  return config[repo];

}
function parseConfig(cfg) {
  var path = cfg["path"]
  var url = cfg["github_url"]
  var org = url.split("/")[0]
  return [path, org]
}

async function syncDependencies(repo) {
  var cfg = getConfig(repo)
  //read info about repo to update from config file 
  var path_and_org = parseConfig(cfg)
  var owner = path_and_org[1]
  var path = path_and_org[0]

  var s3_dep_list = await list(path)
  //get latest versions of tar file on s3 bucket 
  var gh_latest_release = await getLatest(repo, owner)
  //gets latest version of the repo on Github 

  var g_tag = gh_latest_release.data.tag_name.replace("v", "")
  //remove the v and leave just the version number 

  if (!s3_dep_list) {
    //if there are no versions stored on the s3 bucket of this repo 
    updateDep(repo + "-" + g_tag + ".tar.gz", g_tag, repo, owner)
    return
  }

  var s3_latest = s3_dep_list[0]
  //s3_latest is sorted descending alphabetically so the first element will give the latest version in s3 bucket 
  var s3_latest_tag = s3_latest.Key.substring(s3_latest.Key.indexOf('-') + 1, s3_latest.Key.indexOf(".tar"))
  //geting version number of latest tar file stored in s3 bucket 
  console.log(s3_latest_tag)
  console.log(g_tag)


  if (compareVersions(g_tag, s3_latest_tag)) {
    //if version on Github is newer than one stored on s3, update depenendency 
    console.log("Updating Dependency")
    updateDep(repo + "-" + g_tag + ".tar.gz", g_tag, repo, owner)
  }
  else{
    console.log("Dependency Already Up to Date")
  }

}

repo_list.forEach(element => {
  syncDependencies(element)
});
