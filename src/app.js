/* eslint-disable no-restricted-syntax */
// @flow

import Koa from 'koa';
import contentType from 'content-type';
import getRawBody from 'raw-body';
import crypto from 'crypto';
import bufferEquals from 'buffer-equal-constant-time';
import _ from 'lodash';
import { buildSchema, findBreakingChanges, GraphQLError } from 'graphql';

import type { BreakingChange } from 'graphql';
import type { GhFile, AnalysisResult } from './TypeDefinition';

import * as gh from './github';
import replacers from './replacers';

const GITHUB_PR_OPENED = 'opened';
const GITHUB_PR_SYNCHRONIZED = 'synchronize';
const FILE_FILTER = /.*(.graphql|.gql)$/;

const validActions = [GITHUB_PR_OPENED, GITHUB_PR_SYNCHRONIZED];

const getMessagesForBreakingChanges = (breakingChangeType: string, breakingChanges: Array<BreakingChange>) => {
  const replacer = replacers[breakingChangeType];
  const messages = [replacer.title];

  breakingChanges.reduce((arr, item) => {
    arr.push(item.description.replace(replacer.from, replacer.to));
    return arr;
  }, messages);

  return messages;
};

const buildSchemaFromEncodedString = (content: string) => {
  const fileContent = Buffer.from(content, 'base64').toString('utf8');
  const schema = buildSchema(fileContent);
  return schema;
};

const filterSchemaFiles = (files: Array<GhFile>) => files.filter(({ filename }) => filename.match(FILE_FILTER));

const signBlob = (key, blob) => {
  const signature = crypto.createHmac('sha1', key).update(blob).digest('hex');
  return `sha1=${signature}`;
};

const app = new Koa();
app.use(async (ctx, next) => {

  if (!ctx.request.headers['content-length'] || !ctx.request.headers['content-type']) {
    return;
  }

  ctx.request.rawBody = await getRawBody(ctx.req, {
    length: ctx.request.headers['content-length'],
    limit: '5mb',
    encoding: contentType.parse(ctx.request).parameters.charset,
  });
  ctx.request.body = JSON.parse(ctx.request.rawBody);
  await next();
});

app.use(async (ctx, next) => {
  const signature = ctx.request.headers['x-hub-signature'];
  const event = ctx.request.headers['x-github-event'];
  const id = ctx.request.headers['x-github-delivery'];

  console.log(`Received webhook ${id} for event ${event}.`);
  const computedSig = new Buffer(signBlob(process.env.GITHUB_WEBHOOK_SECRET, ctx.request.rawBody));

  if (!bufferEquals(new Buffer(signature), computedSig)) {
    ctx.throw(500, 'X-Hub-Signature does not match blob signature.');
  }

  ctx.body = 'Ok';

  if (event === 'pull_request') {
    await next();
  }
});

app.use(async (ctx) => {
  const data = ctx.request.body;
  const pullRequestPayload = data.pull_request;
  const { repository: repo } = data;
  const path = '.github/graphql-schema-police.yml'

  if (!pullRequestPayload) {
    return;
  }

  if (!validActions.includes(data.action)) {
    return;
  }

  const { base, head } = pullRequestPayload;

  await gh.authenticateGithubApp(data.installation.id);

  const realBaseSha = await gh.findBaseCommit(head.user.login, head.repo.name, pullRequestPayload.number);

  if (realBaseSha) {
    payloadSha = base.sha;
    base.sha = realBaseSha;
  } else {
    return;
  }

  try {
    const { data: originalFileContent } = await gh.getFileContent(
      base.user.login,
      base.repo.name,
      path,
      base.sha,
    );
  } catch (err) {
    return;
  }

  const thisBotComment = await gh.findThisBotComment(head.user.login, head.repo.name, pullRequestPayload.number);
  
  const changedFiles = await gh.getFilesFromCommit(head.user.login, head.repo.name, head.sha);

  const changedSchemaFiles = filterSchemaFiles(changedFiles);

  var requestLog = {
    "message": "Processed paylod"
    "webhookId": ctx.request.headers['x-github-delivery'],
    "pullRequestUrl": pullRequestPayload.url,
    "pullRequestTitle": pullRequestPayload.title,
    "head": {
      "userLogin": head.user.login,
      "repoName": head.repo.name,
      "sha": head.sha
    },
    "base": {
      "userLogin": base.user.login,
      "repoName": base.repo.name,
      "updatedSha": base.sha,
      "payloadSha": payloadSha
    },
    "git_commit_url": "https://api.github.com/repos/"+head.user.login+"/"+head.repo.name+"/git/commits/"+head.sha,
    "previousBotComment": thisBotComment,
    "Files": {
      'changedFiles': changedFiles,
      'changedSchemaFiles': changedSchemaFiles
    }
  };
  
  console.log(requestLog);

  // No schema files were modified
  if (!changedSchemaFiles.length) {
    console.log('No changes to .graphql files found in webhook:', ctx.request.headers['x-github-delivery']);
    return;
  }

  const analysisResults = await changedSchemaFiles.reduce(async (accumP: Promise<Array<AnalysisResult>>, file) => {
    const arr = await accumP;
    try {
      let originalFileName = file.filename;
      // verify if the file was renamed, if yes, use previous name
      if (file.status === 'renamed') {
        // In case there were no changes, ignore this file.
        if (file.changes === 0) {
          throw new Error('Schema file renamed, but no changes detected.');
        }
        originalFileName = file.previous_filename;
      }

      const { data: originalFileContent } = await gh.getFileContent(
        base.user.login,
        base.repo.name,
        originalFileName,
        base.sha,
      );
      const { data: changedFileContent } = await gh.getFileContent(
        head.user.login,
        head.repo.name,
        file.filename,
        head.sha,
      );
      let parseError = null;
      let schemaError = null;
      let breakingChanges = [];

      try {
        const originalSchema = buildSchemaFromEncodedString(originalFileContent.content);
        const changedSchema = buildSchemaFromEncodedString(changedFileContent.content);

        breakingChanges = findBreakingChanges(originalSchema, changedSchema);
      } catch (error) {
        if (error instanceof GraphQLError) {
          parseError = error;
        } else {
          schemaError = error;
        }
      }

      arr.push({
        file: file.filename,
        url: changedFileContent.html_url,
        schemaError,
        parseError,
        breakingChanges,
      });
    } catch (error) {
      if (error.code !== 404 && error.message !== 'Schema file renamed, but no changes detected.') {
        console.error(error);
      }
    }
    return arr;
  }, Promise.resolve([]));

  let commentBody = [];

  for (const result of analysisResults) {
    var changesLog = {
      'message': 'Performed analysis',
      'previousBotComment': thisBotComment,
      'breakingChanges': result.breakingChanges,
      'schemaError': result.schemaError,
      'parseError': result.parseError,
      'webhookId': ctx.request.headers['x-github-delivery'],
      'file': result.file,
      'pullRequestUrl': pullRequestPayload.url
    }
    
    console.log(changesLog);

    if (result.schemaError) {
      commentBody.push(`### :bangbang: Error reading file: [\`${result.file}\`](${result.url})`);
      commentBody.push(result.schemaError.message);
    }
    else {
      if(!thisBotComment && !result.breakingChanges.length && !result.parseError) {
        return;    
      }

      if (!result.breakingChanges.length) {
        if (result.parseError) {
          const errorMessage = result.parseError.message;
          const errorMessagePieces = errorMessage.split('\n\n');
          const message = errorMessagePieces[0];
          const code = errorMessagePieces[1];
          commentBody.push(`### :construction: Syntax error in file: [\`${result.file}\`](${result.url})`);
          commentBody.push(message);
          commentBody.push(`\`\`\`graphql\n${code}\n\`\`\``);
        } 
        else {
          commentBody.push(`### :tada: No breaking changes detected in file: [\`${result.file}\`](${result.url})`);
        }
      }

      const breakingChanges = _.groupBy(result.breakingChanges, 'type');
      if(result.breakingChanges.length) {
        commentBody.push(`### :police_car: Breaking changes detected in file: [\`${result.file}\`](${result.url})`);
        commentBody.push(`Changes you have made will break GraphQL API functionality for our clients. Avoid these changes or provide a clear justification if they are neccessary. Learn more about [extending schemas](https://github.com/Shopify/graphql#extending-schemas-and-versioning).`);
      }
      for (const breakingChangeType in breakingChanges) {
        commentBody = commentBody.concat(
          getMessagesForBreakingChanges(breakingChangeType, breakingChanges[breakingChangeType]),
        );
      }
    }
  } 

  var commentLog = {
    'pullRequestUrl': pullRequestPayload.url,
    'comment': commentBody.join('\n'),
    'webhookId': ctx.request.headers['x-github-delivery'],
    'pullRequestUrl': pullRequestPayload.url
  }

  if (thisBotComment) {
    if (!commentBody.length) {
      console.log('No breaking changes in ${result.file} file for PR [unreachable]:', pullRequestPayload.html_url);
      commentBody.push('No breaking changes detected :tada:');
    }
    commentLog['message'] = 'Updated comment';
    console.log(commentLog);
    await gh.updateComment(repo.owner.login, repo.name, thisBotComment.id, commentBody.join('\n'));
  } 
  else {
    commentLog['message'] = 'Created comment';
    console.log(commentLog);
    await gh.createComment(repo.owner.login, repo.name, pullRequestPayload.number, commentBody.join('\n'));
  }
});

export default app;
