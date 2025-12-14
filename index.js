import fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import path from 'path';
import { differenceInYears, differenceInMonths, differenceInDays } from 'date-fns';

// Configuration
const REPO_OWNER = process.env.REPO_OWNER;
const GH_TOKEN = process.env.ACCESS_TOKEN;
const HEADERS = {
  Authorization: `token ${GH_TOKEN}`,
  'Content-Type': 'application/json',
};

// UPTIME calculation
const UPTIME_START = '2021-10-25';

// GraphQL Queries
const USER_QUERY = `
query($login: String!) {
  user(login: $login) {
    id
    createdAt
    followers {
      totalCount
    }
    contributionsCollection {
      contributionCalendar {
        totalContributions
      }
    }
  }
}
`;

const REPO_QUERY = `
query($login: String!, $cursor: String, $ownerAffiliations: [RepositoryAffiliation]) {
  user(login: $login) {
    repositories(first: 60, after: $cursor, ownerAffiliations: $ownerAffiliations) {
      edges {
        node {
          nameWithOwner
          stargazers {
            totalCount
          }
          defaultBranchRef {
            target {
              ... on Commit {
                history {
                  totalCount
                }
              }
            }
          }
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
}
`;

const COMMIT_HISTORY_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $cursor) {
            edges {
              node {
                additions
                deletions
                author {
                  user {
                    login
                  }
                }
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    }
  }
}
`;

async function graphqlRequest(query, variables) {
  try {
    const response = await axios.post('https://api.github.com/graphql', {
      query,
      variables
    }, { headers: HEADERS });
    if (response.data.errors) {
      console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
      throw new Error('GraphQL Error');
    }
    return response.data.data;
  } catch (error) {
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function getUserData() {
  const data = await graphqlRequest(USER_QUERY, { login: REPO_OWNER });
  return data.user;
}

// Age calculator
function getUptime(startDate) {
  const now = new Date();
  const start = new Date(startDate);

  const years = differenceInYears(now, start);

  // Calculate months relative to the UPTIME_START
  // If now month < start month, or (now month == start month && now day < start day), we haven't reached usage month?
  // date-fns handles this difference correctly for "full" months/years.
  // To get remaining months:
  const months = differenceInMonths(now, start) % 12;

  // To get remaining days:
  // We can add the years and months to the start date and diff days
  let tempDate = new Date(start);
  tempDate.setFullYear(tempDate.getFullYear() + years);
  tempDate.setMonth(tempDate.getMonth() + months);

  const days = differenceInDays(now, tempDate);

  return `${years} years, ${months} months, ${days} days`;
}

// Recursive function to get all repos
async function getAllRepos(ownerAffiliations) {
  let repos = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const data = await graphqlRequest(REPO_QUERY, {
      login: REPO_OWNER,
      cursor,
      ownerAffiliations
    });
    const repoData = data.user.repositories;
    repos = repos.concat(repoData.edges);
    console.log(`Fetched ${repos.length} repos...`);
    hasNextPage = repoData.pageInfo.hasNextPage;
    cursor = repoData.pageInfo.endCursor;
  }
  return repos;
}

async function getRepoStats(repos, cacheFile) {
  let cache = {};
  if (fs.existsSync(cacheFile)) {
    try {
      const lines = fs.readFileSync(cacheFile, 'utf8').split('\n');
      lines.forEach(line => {
        if (line.trim() && !line.startsWith('This line')) {
          const parts = line.split(' ');
          if (parts.length >= 5) {
            cache[parts[0]] = {
              totalCommits: parseInt(parts[1]),
              myCommits: parseInt(parts[2]),
              additions: parseInt(parts[3]),
              deletions: parseInt(parts[4])
            };
          }
        }
      });
    } catch (e) {
      console.log('Error reading cache', e);
    }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalMyCommits = 0;
  let newCacheLines = [];

  for (const edge of repos) {
    const repo = edge.node;
    const name = repo.nameWithOwner;
    const hash = crypto.createHash('sha256').update(name).digest('hex');
    const currentTotalCommits = repo.defaultBranchRef ? repo.defaultBranchRef.target.history.totalCount : 0;

    let stats = { myCommits: 0, additions: 0, deletions: 0 };

    if (cache[hash] && cache[hash].totalCommits === currentTotalCommits) {
      stats = {
        myCommits: cache[hash].myCommits,
        additions: cache[hash].additions,
        deletions: cache[hash].deletions
      };
      // console.log(`Cache hit for ${name}`);
      newCacheLines.push(`${hash} ${currentTotalCommits} ${stats.myCommits} ${stats.additions} ${stats.deletions}`);
    } else {
      if (currentTotalCommits > 0) {
        const [owner, repoName] = name.split('/');
        try {
          console.log(`Fetching history for ${name}...`);
          stats = await fetchRepoHistory(owner, repoName);
          newCacheLines.push(`${hash} ${currentTotalCommits} ${stats.myCommits} ${stats.additions} ${stats.deletions}`);
        } catch (e) {
          console.error(`Failed to fetch history for ${name}: ${e.message}`);
          newCacheLines.push(`${hash} 0 0 0 0`);
        }
      } else {
        newCacheLines.push(`${hash} 0 0 0 0`);
      }
    }

    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;
    totalMyCommits += stats.myCommits;
  }

  try {
    if (!fs.existsSync('cache')) fs.mkdirSync('cache');
    fs.writeFileSync(cacheFile, newCacheLines.join('\n'));
  } catch (e) {
    console.error('Error writing cache', e);
  }

  return {
    additions: totalAdditions,
    deletions: totalDeletions,
    myCommits: totalMyCommits
  };
}

async function fetchRepoHistory(owner, name) {
  let additions = 0;
  let deletions = 0;
  let myCommits = 0;
  let hasNextPage = true;
  let cursor = null;
  let pages = 0;

  while (hasNextPage && pages < 100) {
    if (pages % 5 === 0) console.log(`  Page ${pages} for ${name}...`);
    const data = await graphqlRequest(COMMIT_HISTORY_QUERY, { owner, name, cursor });
    if (!data.repository || !data.repository.defaultBranchRef) break;

    const history = data.repository.defaultBranchRef.target.history;

    for (const edge of history.edges) {
      if (edge.node.author.user && edge.node.author.user.login === REPO_OWNER) {
        myCommits++;
        additions += edge.node.additions;
        deletions += edge.node.deletions;
      }
    }

    hasNextPage = history.pageInfo.hasNextPage;
    cursor = history.pageInfo.endCursor;
    pages++;
  }

  return { myCommits, additions, deletions };
}

function updateSvg(filePath, stats) {
  const content = fs.readFileSync(filePath, 'utf8');
  const $ = cheerio.load(content, { xmlMode: true });

  const set = (id, val, pad = 0) => {
    $(`#${id}`).text(val);
    if (pad > 0) {
      const dots = Math.max(0, pad - String(val).length);
      let dotString = '';
      if (dots <= 2) {
        if (dots === 1) dotString = ' ';
        else if (dots === 2) dotString = '. ';
      } else {
        dotString = ' ' + '.'.repeat(dots) + ' ';
      }
      $(`#${id}_dots`).text(dotString);
    }
  };

  const format = (n) => n.toLocaleString();

  set('age_data', stats.uptime, 49);
  set('commit_data', format(stats.commits), 22);
  set('star_data', format(stats.stars), 14);
  set('repo_data', format(stats.repos), 7);
  set('contrib_data', format(stats.contribs));
  set('follower_data', format(stats.followers), 10);
  set('loc_data', format(stats.loc), 15);
  set('loc_add', format(stats.locAdd));
  set('loc_del', format(stats.locDel));

  fs.writeFileSync(filePath, $.xml());
}

async function main() {
  console.log('Starting update...');

  const user = await getUserData();
  const followers = user.followers.totalCount;

  const uptime = getUptime(UPTIME_START);

  const repos = await getAllRepos(['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER']);

  const ownedRepos = repos.filter(r => {
    return r.node.nameWithOwner.startsWith(REPO_OWNER + '/');
  });

  const totalStars = ownedRepos.reduce((acc, r) => acc + r.node.stargazers.totalCount, 0);
  const repoCount = ownedRepos.length;

  const cacheFile = path.join('cache', crypto.createHash('sha256').update(REPO_OWNER).digest('hex') + '.txt');
  const locStats = await getRepoStats(repos, cacheFile);

  const stats = {
    uptime,
    commits: locStats.myCommits,
    stars: totalStars,
    repos: repoCount,
    contribs: repos.length,
    followers,
    loc: locStats.additions - locStats.deletions,
    locAdd: locStats.additions,
    locDel: locStats.deletions
  };

  console.log('Stats:', stats);

  updateSvg('light.svg', stats);
  updateSvg('dark.svg', stats);

  console.log('Done!');
}

main().catch(console.error);
