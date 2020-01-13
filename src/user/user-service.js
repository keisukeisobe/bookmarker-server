const bcrypt = require('bcryptjs');
const passwordChecker = require('password-checker');
const emailValidator = require('email-validator');
const checker = new passwordChecker();
const uuid = require('uuid/v4');

checker.requireLetters(true);
checker.requireNumbersOrSymbols(true);
checker.min_length = 8;
checker.max_length = 72; //bcrypt
//disallow params:
//active
//in_password (true to disallow passwords that contain a disallowed entry at all, default off)
//len (min length of match if in_password is on, default 4 for password list, 0 otherwise)
//disallowed lists are case-insensitive
checker.disallowNames(true);
checker.disallowWords(true);
checker.disallowPasswords(true, true, 4);

const UserService = {
  getListIds(db, user_id) {
    console.log('getListIds');
    return db
      .pluck('list_id')
      .from('userlist')
      .where('user_id', user_id);
  },
  getNodeIds(db, list_id) {
    console.log('getNodeIds');
    return db
      .pluck('node_id')
      .from('listnode')
      .whereIn('list_id', list_id);
  },
  getNodes(db, node_ids) {
    console.log('getNodes');
    return db.from('nodes').whereIn('id', node_ids);
  },
  getLists(db, list_ids) {
    console.log('getLists');
    return db.from('lists').whereIn('id', list_ids);
  },

  getNodesFromList(db, list_id) {
    return db('listnode')
      .where({ list_id })
      .join('nodes', 'nodes.id', '=', 'listnode.node_id')
      .select(
        'nodes.id as id',
        'nodes.add_date as add_date',
        'nodes.last_modified as last_modified',
        'nodes.ns_root as ns_root',
        'nodes.title as title',
        'nodes.type as type',
        'nodes.icon as icon',
        'nodes.url as url',
        'listnode.next_node as next_node',
        'listnode.first_child as first_child'
      );
  },

  async addTagsToNodes(db, nodes) {
    const flatNodeObj = {}; //hashmap allows fast addition of tags
    const nodeIds = [];
    for (const node of nodes) {
      const id = node.id;
      node.tags = [];
      nodeIds.push(id);
      flatNodeObj[id] = node;
    }
    const tags = await db('nodetag')
      .whereIn('nodetag.node_id', nodeIds)
      .innerJoin('tags', 'nodetag.tag_id', '=', 'tags.id')
      .select('nodetag.node_id as id', 'tags.tag as tag');
    console.log(tags);
    for (const tag of tags) {
      flatNodeObj[tag.id].tags.push(tag.tag);
    }
  },

  forceIdUUID(id) {
    if (
      id &&
      id.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    ) {
      return id;
    }
    return uuid();
  },

  async serializeList(db, list_id) {
    //for now only worry about flat lists of bookmarks
    const nodes = await this.getNodesFromList(db, list_id);
    const bookmarks = {
      bookmarks: {
        ns_root: 'toolbar',
        title: 'Bookmarks bar',
        type: 'folder',
        children: []
      }
    };
    //TODO update DB to include first node on the lists object
    //in the meantime, work around it with hashmaps
    //this only works for flat structures, need a direct way to find first node to generalize

    //iterate through array once to build hashset of ids pointed to by next_node
    //and hashmap of node ids to nodes (this buys us O(n) performance instead of O(n^2))
    //with a flat structure there should be exactly one node not pointed to, which is the head
    //follow the trail of pointers and add nodes to the list in order
    let seen = new Set();
    let nodeObj = {};
    for (const node of nodes) {
      seen.add(node.next_node);
      nodeObj[node.id] = node;
    }
    const first = [...nodes].filter(node => !seen.has(node.id));
    if (first.length !== 1) {
      throw new Error('bookmark structure corrupted');
    }
    let cur = first[0];
    while (cur) {
      bookmarks.bookmarks.children.push(cur);
      cur = nodeObj[cur.next_node];
    }
    //TODO: santize bookmarks
    return JSON.stringify(bookmarks);
  },

  async createStructure(db, list_id) {
    const nodes = await this.getNodesFromList(db, list_id);
    // console.log(nodes);
    await this.addTagsToNodes(db, nodes);
    const [first_node_id] = await db('lists')
      .pluck('head')
      .where('id', list_id);
    //initialize with root folder
    const nodeObj = {
      0: {
        name: '',
        id: 0,
        contents: []
      }
    };
    const folders = { 0: first_node_id };
    for (const node of nodes) {
      nodeObj[node.id] = node;
      if (node.first_child) {
        folders[node.id] = node.first_child;
      }
    }
    // console.log(folders);
    for (const [folderId, headId] of Object.entries(folders)) {
      // console.log(folderId);
      const contents = [];
      let cur = nodeObj[headId];

      while (cur) {
        contents.push(cur);
        const next = nodeObj[cur.next_node];
        delete cur.first_child;
        delete cur.next_node;
        cur = next;
      }
      nodeObj[folderId].contents = contents;
      // console.log(nodeObj[folderId]);
    }
    return nodeObj[0];
  },

  async insertStructuredList(db, list, listName, user_id, list_id = null) {
    // console.log(list);
    this.forceIds(list.contents);
    const nodes = this.flattenList(list.contents);
    const head = list.contents[0].id;

    const nodeContents = [];
    let nodePointers = [];
    let nodeTags = []; //[id, tag] as array for
    let tags = {};
    nodes.forEach(node => {
      let { next_node, first_child, id, ...contents } = node;
      let ptrs = [id, next_node || null, first_child || null];
      //TODO if id not UUID generate UUIDv4

      contents.id = id;
      let contentArr = [
        contents.id,
        contents.add_date,
        contents.last_modified,
        contents.ns_root,
        contents.title,
        contents.type,
        contents.icon,
        contents.url
      ];
      if (node.tags) {
        for (const tag of node.tags) {
          nodeTags.push({ id, tag });
          tags[tag] = null;
        }
      }

      contentArr = contentArr.map(val => (val === undefined ? null : val));
      nodeContents.push(contentArr);
      ptrs = ptrs.map(val => (val === undefined ? null : val));
      nodePointers.push(ptrs);
    });

    await db.transaction(async trx => {
      if (list_id) {
        await trx('lists')
          .where('id', list_id)
          .update({ name: listName, head });
      } else {
        // eslint-disable-next-line require-atomic-updates
        [list_id] = await trx('lists')
          .insert({
            head,
            name: listName
          })
          .returning('id');
        // console.log(list_id);
      }
      // await db('userlist')
      //   .transacting(trx)
      //   .insert({ list_id, user_id })
      //   .catch(); //if it collides we're ok

      await trx.raw(
        'INSERT INTO userlist (list_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
        [list_id, user_id]
      );
      // console.log(list_id);
      nodePointers = nodePointers.map(ptrArr => [list_id, ...ptrArr]);
      // console.log('contents', nodeContents);
      const spreadContents = [].concat(...nodeContents);
      const spreadPointers = [].concat(...nodePointers);
      // console.log(spreadContents, nodePointers);
      await trx.raw(
        `INSERT INTO nodes (id, add_date, last_modified, ns_root, title, type, icon, url) VALUES ${nodes
          .map(_ => '(?, ?, ?, ?, ?, ?, ?, ?)')
          .join(
            ', '
          )} ON CONFLICT (id) DO UPDATE SET (add_date, last_modified, ns_root, title, type, icon, url) = (EXCLUDED.add_date, EXCLUDED.last_modified, EXCLUDED.ns_root, EXCLUDED.title, EXCLUDED.type, EXCLUDED.icon, EXCLUDED.url)`,
        spreadContents
      );

      await trx.raw(
        `INSERT INTO listnode (list_id, node_id, next_node, first_child) VALUES ${nodes
          .map(_ => '(?, ?, ?, ?)')
          .join(
            ', '
          )} ON CONFLICT (list_id, node_id) DO UPDATE SET (next_node, first_child) = (EXCLUDED.next_node, EXCLUDED.first_child)`,
        spreadPointers
      );

      const tagArr = Object.keys(tags);

      await trx.raw(
        `INSERT INTO tags (tag) VALUES ${tagArr
          .map(_ => '(?)')
          .join(', ')} ON CONFLICT DO NOTHING`,
        tagArr
      );

      const knownTags = await trx('tags')
        .whereIn('tag', tagArr)
        .select('id', 'tag');

      // let knownTags = await trx('tags')
      //   .whereIn('tag', tagArr)
      //   .select('id', 'tag');
      // console.log('old', knownTags);
      // if (Array.isArray(knownTags)) {
      //   for (const t of knownTags) {
      //     tags[t.tag] = t.id;
      //   }
      // }
      // const unknownTags = tagArr
      //   .filter(tag => !tags[tag])
      //   .map(tag => {
      //     tag;
      //   });

      // knownTags = await trx('tags')
      //   .insert(unknownTags)
      //   .returning('id', 'tag');
      // console.log('new', knownTags);
      // if (Array.isArray(knownTags)) {
      //   for (const t of knownTags) {
      //     tags[t.tag] = t.id;
      //   }
      // }
      for (const t of knownTags) {
        tags[t.tag] = t.id;
      }
      console.log(tags);

      nodeTags = nodeTags.map(({ id, tag }) => {
        // console.log(id, tag);
        return [id, tags[tag]];
      });

      const flatTags = [].concat(...nodeTags); //[node_id, tag_id, node_id, tag_id] etc
      console.log(flatTags);
      await trx.raw(
        `INSERT INTO nodetag (node_id, tag_id) VALUES ${nodeTags
          .map(_ => '(?, ?)')
          .join(', ')} ON CONFLICT DO NOTHING`,
        flatTags
      );
    });
    return list_id;
  },

  forceIds(list) {
    list.forEach(node => {
      let { contents, children } = node;
      contents = contents === undefined ? children : contents;
      if (contents) {
        this.forceIds(contents);
      }
      node.id = this.forceIdUUID(node.id);
    });
  },

  flattenList(list) {
    console.log('flatten');
    const nodes = [];
    list.forEach((node, idx) => {
      let { contents, children, ...temp } = node;
      // console.log('contents', contents)
      // console.log('children', children)
      contents = contents === undefined ? children : contents;
      // console.log(Array.isArray(contents))
      if (contents) {
        temp.first_child = contents[0].id;
        temp.type = 'folder';
        //order might be wonky but that doesn't matter
        const childNodes = this.flattenList(contents);
        // console.log('children', childNodes.map(node => {
        //   const {icon, ...rest} = node;
        //   return rest;
        // }));
        nodes.push(...childNodes);
      } else {
        temp.type = 'bookmark';
      }
      const next = list[idx + 1];
      temp.next_node = next ? next.id : null;
      nodes.push(temp);
    });
    // console.log('flat', nodes.map(node => {
    //   const {icon, ...rest} = node;
    //   return rest;
    // }));
    return nodes;
  },

  hasUserWithUserName(db, username) {
    return db('users')
      .where({ username })
      .first()
      .then(user => !!user);
  },

  hasUserWitEmail(db, email) {
    return db('users')
      .where({ email })
      .first()
      .then(user => !!user);
  },

  insertUser(db, newUser) {
    return db('users')
      .insert(newUser)
      .returning('*')
      .then(([user]) => user);
  },

  hashPassword(password) {
    return bcrypt.hash(password, 12);
  },

  validateEmail(email) {
    return emailValidator.validate(email);
  },

  validatePassword(password) {
    if (checker.check(password)) {
      return null;
    }
    let err = checker.errors;
    return err[0].toString().slice(7);
    //err is array of failed rules, entries are error objects, toString gets 'Error: description of error'
  },
  //insert into list
  //insert into userlist
  //insert into folder
  //insert into listfolder
  //insert into bookmarks
  //insert into folderbookmarks

  insertListSimple(db) {
    return db
      .insert({ name: 'main' })
      .into('lists')
      .returning('*')
      .then(([list]) => list);
  },
  insertUserlistSimple(db, user_id, list_id) {
    return db
      .insert({ user_id, list_id })
      .into('userlist')
      .returning('*');
  },
  insertNodesSimple(db, node) {
    return db
      .insert(node)
      .into('nodes')
      .returning('*');
  },
  insertListnodeSimple(db, list_id, node_id) {
    return db
      .insert({ list_id, node_id })
      .into('listnode')
      .returning('*');
  },
  insertTagSimple(db, tag) {
    return db
      .insert({ tag })
      .into('tags')
      .returning('*');
  },
  insertNodetagSimple(db, bookmark_id, tag_id) {
    return db
      .insert({ bookmark_id, tag_id })
      .into('tagbookmark')
      .returning('*');
  }
};

module.exports = UserService;
