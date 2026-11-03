const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {createRequire} = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');

const ExcelJS = require('exceljs');
const excelDependency = createRequire(require.resolve('exceljs'));
const archiver = excelDependency('archiver');
const archiverFiles = excelDependency('archiver-utils/file');
const unzipper = excelDependency('unzipper');
const zipDependency = createRequire(excelDependency.resolve('zip-stream'));
const zipArchiverFiles = zipDependency('archiver-utils/file');

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test('ExcelJS and archiver retain their read, write, and glob interfaces', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pellet-dependency-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Report').addRow(['DO-100', 42]);
  const workbookBuffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(workbookBuffer);
  assert.deepEqual(loaded.getWorksheet('Report').getRow(1).values.slice(1), ['DO-100', 42]);

  const workbookFile = path.join(directory, 'streamed.xlsx');
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({filename: workbookFile});
  writer.addWorksheet('Report').addRow(['DO-200', 84]).commit();
  await writer.commit();
  const streamedRows = [];
  for await (const sheet of new ExcelJS.stream.xlsx.WorkbookReader(workbookFile)) {
    for await (const row of sheet) streamedRows.push(row.values.slice(1));
  }
  assert.deepEqual(streamedRows, [['DO-200', 84]]);

  const input = path.join(directory, 'input');
  await fs.mkdir(path.join(input, 'nested'), {recursive: true});
  await fs.writeFile(path.join(input, 'nested', 'included.txt'), 'included');
  await fs.writeFile(path.join(input, 'nested', 'ignored.txt'), 'ignored');
  await fs.writeFile(path.join(input, 'nested', 'other.csv'), 'other');

  for (const files of [archiverFiles, zipArchiverFiles]) {
    assert.deepEqual(
      files.expand({cwd: input}, ['**/*.txt', '!**/ignored.txt']),
      [path.join('nested', 'included.txt')],
    );
  }

  const archive = archiver('zip');
  const archiveBufferPromise = collect(archive);
  archive.glob('**/*.txt', {cwd: input, ignore: ['**/ignored.txt']});
  await archive.finalize();
  const archiveBuffer = await archiveBufferPromise;
  const zip = await unzipper.Open.buffer(archiveBuffer);
  assert.deepEqual(zip.files.map(file => file.path), ['nested/included.txt']);
});
