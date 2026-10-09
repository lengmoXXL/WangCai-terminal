const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { buildSync } = require('esbuild');
const { Module } = require('node:module');
const compiled = new Module('terminal-links');
compiled._compile(buildSync({ entryPoints: ['file-links/links.ts'], bundle: true, platform: 'node', write: false }).outputFiles[0].text, 'terminal-links.cjs');
const { fileLocation, registerFileLinks } = compiled.exports;

// A terminal the link provider can scan, with the files the plugin would answer for: everything
// else on a line is left as plain text, which is what the filesystem decides in the app.
function pane(terminal, existing, hold = () => {}) {
  let provider;
  const clicks = [];
  // A terminal face the plugin registers with, whose columns answer for the terminal it draws on: a
  // resize cuts the rows again under a line the plugin already read.
  registerFileLinks({ options: {}, get cols() { return terminal.cols; }, buffer: terminal.buffer, registerLinkProvider(value) { provider = value; } }, {
    resolve: async (paths) => {
      await hold();
      return Object.fromEntries(paths.filter(path => path in existing).map(path => [path, existing[path]]));
    },
    activate: (path, line, column) => clicks.push({ path, line, column }),
  });
  const write = (text) => new Promise(resolve => terminal.write(text, resolve));
  return { write, clicks, links: (y) => new Promise(resolve => provider.provideLinks(y, resolve)) };
}

test('file links: absolute paths, file URLs, line/column and wrapped Unicode cells', async () => {
  assert.deepEqual(fileLocation('/tmp/test.ts:42:8'), { path: '/tmp/test.ts', line: 42, column: 8 });
  assert.deepEqual(fileLocation('file://vm149/tmp/a%20b.md'), { path: '/tmp/a b.md', line: undefined, column: undefined });
  assert.deepEqual(fileLocation('src/relative.ts:12'), { path: 'src/relative.ts', line: 12, column: undefined });
  assert.equal(fileLocation('../README.md').path, '../README.md');
  assert.equal(fileLocation('./main.rs').path, './main.rs');
  assert.equal(fileLocation('https://example.com/a.ts'), undefined);
  assert.equal(fileLocation('file:///%ZZ'), undefined);
  const terminal = new Terminal({ cols: 24, rows: 5, allowProposedApi: true });
  const view = pane(terminal, {
    '/tmp/long-directory/file.ts': '/tmp/long-directory/file.ts',
    './main.rs': '/work/main.rs',
    '../README.md': '/work/README.md',
    Makefile: '/work/Makefile',
  });
  await view.write('中文 /tmp/long-directory/file.ts:42:8\r\nhttps://example.com/a.ts');
  const links = await view.links(2);
  assert.equal(links.length, 1);
  // The location is underlined, and the click opens the path the plugin resolved.
  assert.equal(links[0].text, '/tmp/long-directory/file.ts:42:8');
  assert.deepEqual(links[0].range.start, { x: 6, y: 1 });
  assert.equal(links[0].range.end.y, 2);
  links[0].activate();
  assert.deepEqual(view.clicks, [{ path: '/tmp/long-directory/file.ts', line: 42, column: 8 }]);
  assert.deepEqual(await view.links(3), []);
  await view.write('\r\n./main.rs ../README.md Makefile');
  const relative = await view.links(4);
  assert.deepEqual(relative.map(link => link.text), ['./main.rs', '../README.md', 'Makefile']);
  terminal.dispose();
});

test('command options are not file links; the paths inside them still are', async () => {
  assert.equal(fileLocation('--exclude-dir=.svn'), undefined);
  assert.equal(fileLocation('./-notes.md').path, './-notes.md');
  const terminal = new Terminal({ cols: 120, rows: 3, allowProposedApi: true });
  const view = pane(terminal, {
    './result.txt': '/work/result.txt',
    'src/main.ts': '/work/src/main.ts',
    './-notes.md': '/work/-notes.md',
  });
  await view.write('rg --exclude-dir=.svn --output=./result.txt -I./include src/main.ts ./-notes.md');
  const links = await view.links(1);
  assert.deepEqual(links.map(link => link.text), ['./result.txt', 'src/main.ts', './-notes.md']);
  terminal.dispose();
});

test('compiler and traceback locations are links, in the shapes they print', async () => {
  assert.deepEqual(fileLocation('src/a.ts(12,3)'), { path: 'src/a.ts', line: 12, column: 3 });
  assert.deepEqual(fileLocation('src/a.ts(12)'), { path: 'src/a.ts', line: 12, column: undefined });
  assert.deepEqual(fileLocation('"a file.ts", line 12, column 3'), { path: 'a file.ts', line: 12, column: 3 });
  assert.deepEqual(fileLocation('"a file.ts"'), { path: 'a file.ts', line: undefined, column: undefined });
  // The shapes VS Code's clause list covers: a hash, a space, a dot before the column, a range.
  assert.deepEqual(fileLocation('src/a.ts#12:3'), { path: 'src/a.ts', line: 12, column: 3 });
  assert.deepEqual(fileLocation('src/a.ts 12'), { path: 'src/a.ts', line: 12, column: undefined });
  assert.deepEqual(fileLocation('src/a.ts:12.14'), { path: 'src/a.ts', line: 12, column: 14 });
  assert.deepEqual(fileLocation('"a file.ts", lines 12-14, characters 3-5'), { path: 'a file.ts', line: 12, column: 3 });
  assert.equal(fileLocation('note:12'), undefined);
  // A web address is not a location: the output is linked for what the app can open itself.
  assert.equal(fileLocation('https://example.com/a.ts'), undefined);
  const terminal = new Terminal({ cols: 120, rows: 4, allowProposedApi: true });
  const view = pane(terminal, { 'src/a.ts': '/work/src/a.ts', 'long dir/b file.ts': '/work/long dir/b file.ts' });
  await view.write('error at src/a.ts(12,3)\r\n  File "long dir/b file.ts", line 7, in run\r\nsee https://example.com/a.ts');
  const compiler = await view.links(1);
  assert.deepEqual(compiler.map(link => link.text), ['src/a.ts(12,3)']);
  const traceback = await view.links(2);
  assert.deepEqual(traceback.map(link => link.text), ['"long dir/b file.ts", line 7']);
  assert.deepEqual(await view.links(3), []);
  terminal.dispose();
});

test('only the paths that exist become links, a lone file name included', async () => {
  const terminal = new Terminal({ cols: 120, rows: 5, allowProposedApi: true });
  const view = pane(terminal, {
    './exists.ts': '/work/exists.ts',
    'src/main.ts': '/work/src/main.ts',
    'sample.ts': '/work/sample.ts',
    'INSTALL.md': '/work/INSTALL.md',
    INSTALL: '/work/INSTALL',
  });
  await view.write('./exists.ts ./missing.ts src/main.ts\r\nsample.ts sample.ts:12 missing.ts:12\r\nnote:12 npm 12\r\nsee INSTALL.md and INSTALL');
  assert.deepEqual((await view.links(1)).map(link => link.text), ['./exists.ts', 'src/main.ts']);
  // A file name of its own is a link only while it exists, and it keeps the line it printed.
  const names = await view.links(2);
  assert.deepEqual(names.map(link => link.text), ['sample.ts:12', 'sample.ts']);
  names[0].activate();
  assert.deepEqual(view.clicks, [{ path: '/work/sample.ts', line: 12, column: undefined }]);
  assert.deepEqual(await view.links(3), []);
  // A name a build tool prints is the wider reading of `INSTALL.md`, so its click opens the whole
  // name even while the build-name rule also reads the `INSTALL` inside it, and even when that
  // shorter name exists as a file of its own.
  const build = await view.links(4);
  assert.deepEqual(build.map(link => link.text), ['INSTALL', 'INSTALL.md']);
  build[1].activate();
  assert.deepEqual(view.clicks.at(-1), { path: '/work/INSTALL.md', line: undefined, column: undefined });
  terminal.dispose();
});

test('punctuation printed around a path stays outside it', async () => {
  assert.deepEqual(fileLocation('src/a.ts、新建'), { path: 'src/a.ts', line: undefined, column: undefined });
  const terminal = new Terminal({ cols: 200, rows: 2, allowProposedApi: true });
  const view = pane(terminal, {
    'plugins/file-links/links.ts': '/work/plugins/file-links/links.ts',
    'plugins/file-links/paths.ts': '/work/plugins/file-links/paths.ts',
  });
  await view.write('文件链接那块（plugins/file-links/links.ts、新建 plugins/file-links/paths.ts）\r\n「说明 file.md」，第 3 行');
  const sentence = await view.links(1);
  assert.deepEqual(sentence.map(link => link.text), ['plugins/file-links/links.ts', 'plugins/file-links/paths.ts']);
  // A Chinese sentence around a name without a separator or a line is left alone.
  assert.deepEqual(await view.links(2), []);
  terminal.dispose();
});

test('a path the terminal wrapped is one link on every row, and a resize is read off the rows it has now', async () => {
  const path = '/tmp/a-long-directory-name-0/a-long-directory-name-1/file.ts';
  const terminal = new Terminal({ cols: 24, rows: 10, allowProposedApi: true });
  let looks = 0;
  const view = pane(terminal, { [path]: path }, () => { looks++; });
  await view.write(`${path}\r\n`);
  for (const row of [1, 2, 3]) {
    const found = await view.links(row);
    assert.deepEqual(found.map((link) => link.text), [path], `row ${row} of the wrapped path is a link`);
  }
  assert.equal(looks, 1, 'the wrapped line is looked at once, however many rows it covers');
  const [link] = await view.links(2);
  assert.deepEqual(link.range, { start: { x: 1, y: 1 }, end: { x: 12, y: 3 } }, 'the link covers the whole line, whichever row asks for it');

  // The answer to a look lands a resize late, which is what a slow machine makes of the same line.
  const resized = new Terminal({ cols: 24, rows: 10, allowProposedApi: true });
  let release;
  const held = pane(resized, { [path]: path }, () => new Promise((done) => { release = done; }));
  await held.write(`${path}\r\n`);
  const answered = held.links(2);
  resized.resize(16, 10);
  release();
  const found = await answered;
  // Where a character of the printed line lands once the rows are cut at 16 columns.
  const cellOf = (character) => ({ x: (character % 16) + 1, y: Math.floor(character / 16) + 1 });
  assert.deepEqual(found.map((link) => link.text), [path], 'the line is still a link once the rows have been cut again');
  assert.deepEqual(found[0].range, { start: cellOf(0), end: cellOf(path.length - 1) }, 'the link covers the rows the path has now');
  terminal.dispose();
  resized.dispose();
});
