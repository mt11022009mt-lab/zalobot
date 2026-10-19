const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { groups: {} };
    this.data.groups ||= {};
  }

  group(threadID) {
    const id = String(threadID);
    const group = (this.data.groups[id] ||= {});
    group.members ||= [];
    group.names ||= {};
    group.days ||= {};
    group.recentIDs ||= [];
    group.interactions ||= {};
    group.checkins ||= {};
    group.birthdays ||= {};
    group.birthdayAnnounced ||= {};
    group.warnings ||= {};
    return group;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
