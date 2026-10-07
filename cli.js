#!/usr/bin/env node
const USER_CMDS = ['user-add', 'user-list', 'user-pass', 'user-remove'];
const [cmd, a, b, c] = process.argv.slice(2);

// user management must see the account store even when the server later runs
// with accounts off; env vars must be set before ./config loads
if (USER_CMDS.includes(cmd)) process.env.CLOUDRIVE_ACCOUNTS = 'true';

const config = require('./config');
const accounts = require('./lib/accounts');

async function userCmds() {
  await accounts.ready();
  switch (cmd) {
    case 'user-add':
      if (!a || !b) return console.error(`usage: cli.js user-add <name> <password> [admin|uploader]`);
      await accounts.addUser(a, b, c || 'uploader');
      console.log(`user "${a}" added with role ${c || 'uploader'}`);
      return true;
    case 'user-pass':
      if (!a || !b) return console.error(`usage: cli.js user-pass <name> <password> [admin|uploader]`);
      await accounts.setPassword(a, b, c);
      console.log(`password for "${a}" updated${c ? ` (role: ${c})` : ''}`);
      return true;
    case 'user-remove':
      if (!a) return console.error(`usage: cli.js user-remove <name>`);
      await accounts.removeUser(a);
      console.log(`user "${a}" removed`);
      return true;
    case 'user-list':
      for (const u of accounts.listUsers()) {
        console.log(`${u.name}\t${u.role}\t${u.disabled ? 'disabled' : 'enabled'}\tcreated ${new Date(u.createdAt).toISOString()}`);
      }
      return true;
  }
  return false;
}

(async () => {
  if (USER_CMDS.includes(cmd)) process.exit((await userCmds()) ? 0 : 1);
  require('./app');
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});