// Replays Tower2 coding-v1 (round 060) against the real host snapshot code:
// publish, one later tool call, final answer. The host re-derives the
// published directory's digest; only real byte changes may make it stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createToolLoopGuard} from '../plugin/tool-loop-guard.mjs';
import {createWorkspacePreviewVerifier} from '../plugin/workspace-preview.mjs';

const HOST = fileURLToPath(new URL('../host/workspace_preview.py', import.meta.url));
// Publication reuses publish_snapshot; verification goes through the real
// control-socket handler, including its fail-closed error responses.
const DRIVER = `
import importlib.util, json, os, pathlib, socket, sys, threading
spec = importlib.util.spec_from_file_location("workspace_preview", sys.argv[1])
host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
workspace, previews, request = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), json.loads(sys.stdin.read())
if request["action"] == "publish":
    print(json.dumps(host.publish_snapshot(workspace, previews, request["relativeDirectory"], os.getuid())))
else:
    client, server = socket.socketpair()
    thread = threading.Thread(target=host._serve_connection, args=(server,),
        kwargs={"workspace": workspace, "previews": previews, "owner_uid": os.getuid(), "port": 9437})
    thread.start()
    client.sendall(json.dumps(request).encode() + b"\\n"); client.shutdown(socket.SHUT_WR)
    print(client.makefile("rb").readline().decode().strip()); thread.join(5)
`;
const python = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0;
const root = typeof process.getuid === 'function' && process.getuid() === 0;
const MODEL_ANSWER = 'All tests pass and CLI works correctly.';
const REPORT = 'import csv, json, sys\nrows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8")))\n' +
  'print(json.dumps({r["category"]: r["amount"] for r in rows}))\n';

function fleetFixture(t, {wrapped}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pixel-currency-')));
  t.after(() => { spawnSync('chmod', ['-R', 'u+rwX', dir]); rmSync(dir, {recursive: true, force: true}); });
  const workspace = join(dir, 'workspace'), previews = join(dir, 'previews');
  for (const path of [workspace, previews, join(workspace, 'expense-report'), join(workspace, 'expense-report/public')]) mkdirSync(path, {mode: 0o700});
  const host = request => {
    const run = spawnSync('python3', ['-c', DRIVER, HOST, workspace, previews], {input: JSON.stringify(request), encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  let probes = 0;
  const verify = createWorkspacePreviewVerifier({request: async request => { probes++; return host(request); }});
  const context = {agentId: 'pixel', runId: 'run-060', sessionId: 'session-060', sessionKey: 'agent:pixel:fleet'};
  const guard = createToolLoopGuard({verifyWorkspacePreview: verify,
    ...(wrapped ? {execControl: {prepare: (_run, command) => `/control/wrapper ${Buffer.from(command).toString('base64')}`}} : {})});
  guard.observeRun(context, 'pixel', {prompt: 'Build and publish a website in existing expense-report.'});
  const invoke = (name, params, result, id, {blockable = false} = {}) => {
    const ctx = {...context, toolName: name, toolCallId: id};
    const prepared = guard.beforeToolCall({toolName: name, params, toolCallId: id}, ctx);
    // The runtime reports a blocked call's receipt through both hooks.
    if (blockable && prepared?.block) {
      result = {isError: true, content: [{type: 'text', text: prepared.blockReason}], details: {status: 'blocked'}};
      guard.afterToolCall({toolName: name, params, error: prepared.blockReason, result, toolCallId: id}, ctx);
    } else {
      assert.notEqual(prepared?.block, true, prepared?.blockReason);
      guard.afterToolCall({toolName: name, params: prepared?.params ?? params, result, toolCallId: id}, ctx);
    }
    guard.toolResultPersist({toolName: name, toolCallId: id, message: {role: 'toolResult', toolName: name, toolCallId: id, ...result}}, ctx);
  };
  const write = (path, content, id) => {
    writeFileSync(join(workspace, path), content, {mode: 0o600});
    invoke('write', {path, content}, {content: [{type: 'text', text: `Successfully wrote ${content.length} bytes to ${path}`}]}, id);
  };
  // The exec tool runs the model's command; production wraps it only for cancellation.
  const exec = (command, id) => {
    const run = spawnSync('sh', ['-c', command], {cwd: workspace, encoding: 'utf8'});
    invoke('exec', {command}, {content: [{type: 'text', text: run.stdout + run.stderr}],
      details: {status: 'completed', exitCode: run.status, durationMs: 1, aggregated: run.stdout + run.stderr, cwd: workspace}}, id);
    return run;
  };
  write('expense-report/report.py', REPORT, 'report');
  write('expense-report/data.csv', 'category,amount\nfood,15.75\n', 'data');
  write('expense-report/public/index.html', '<!doctype html><title>Expense report</title><h1>Expense report</h1>', 'index');
  write('expense-report/public/report.py.txt', REPORT, 'copy');
  const published = host({schemaVersion: 1, action: 'publish', relativeDirectory: 'expense-report/public'});
  const url = `http://${published.siteId}.localhost:9437/${published.siteId}/`;
  invoke('pixel_ods_workspace_preview', {relativeDirectory: 'expense-report/public'}, {content: [{type: 'text', text: `Verified browser URL: ${url}`}],
    details: {...published, port: 9437, url, httpStatus: 200, readbackVerified: true}}, 'publish');
  assert.equal(guard.verificationForRun(context.runId).status, 'passed', 'fresh publication is verified');
  return {guard, context, invoke, write, exec, url, probes: () => probes};
}

async function finalAnswer({guard, context, url}) {
  await guard.revalidateWorkspacePreview({}, context);
  const delivered = guard.replyPayloadSending({runId: context.runId, kind: 'final',
    payload: {text: `${MODEL_ANSWER}\n\nPublished preview: ${url}`}});
  return {status: guard.verificationForRun(context.runId).status, text: delivered?.payload?.text ?? ''};
}

const STALE = /has not been verified again since later tool activity/;
const scenarios = {
  // Tower2 round 060: the extra CLI demo read files and wrote only stdout.
  'read-only exec': f => assert.equal(f.exec('python3 expense-report/report.py expense-report/data.csv', 'demo').status, 0),
  'exec rewrites identical bytes': f => f.exec('cp expense-report/public/index.html index.tmp && cat index.tmp > expense-report/public/index.html', 'same'),
  'write outside published dir': f => f.write('expense-report/notes.txt', 'CLI demo passed', 'notes'),
  'exec modifies public/index.html': f => f.exec(`python3 -c "import pathlib; p = pathlib.Path('expense-report/public/index.html'); p.write_text(p.read_text().replace('Expense', 'Changed'))"`, 'modify'),
  'write inside published dir': f => f.write('expense-report/public/index.html', '<!doctype html><title>Changed</title>', 'rewrite'),
  'exec adds a published file': f => f.exec('echo extra > expense-report/public/extra.txt', 'add'),
  'symlink swap to identical bytes': f => f.exec('cp expense-report/public/index.html same.html && rm expense-report/public/index.html && ln -s ../../same.html expense-report/public/index.html', 'swap'),
  'read error': f => f.exec('chmod 000 expense-report/public/report.py.txt', 'unreadable'),
};
const verified = new Set(['read-only exec', 'exec rewrites identical bytes', 'write outside published dir']);

for (const wrapped of [false, true]) for (const [name, act] of Object.entries(scenarios)) {
  test(`post-publication ${name} is ${verified.has(name) ? 'still verified' : 'stale'} (wrapped exec=${wrapped})`,
    {skip: !python ? 'python3 unavailable' : name === 'read error' && root ? 'root reads mode-000 files' : false}, async t => {
      const fixture = fleetFixture(t, {wrapped});
      act(fixture);
      assert.notEqual(fixture.guard.verificationForRun(fixture.context.runId).status, 'passed', 'later activity always requires a fresh host check');
      const delivered = await finalAnswer(fixture);
      assert.equal(fixture.probes(), 1, 'one bounded host comparison at finalization');
      if (verified.has(name)) {
        assert.equal(delivered.status, 'passed');
        assert.ok(delivered.text.startsWith(MODEL_ANSWER), delivered.text);
        assert.doesNotMatch(delivered.text, STALE);
      } else {
        assert.equal(delivered.status, 'failed');
        assert.match(delivered.text, STALE);
        assert.doesNotMatch(delivered.text, new RegExp(MODEL_ANSWER), 'no verification claim for changed bytes');
      }
    });
}

test('read-only calls after the fleet exec neither advance nor revoke the pending comparison', {skip: !python && 'python3 unavailable'}, async t => {
  const fixture = fleetFixture(t, {wrapped: true});
  scenarios['read-only exec'](fixture);
  // Blocked, failed or successful: none of these can change workspace bytes.
  fixture.invoke('process', {action: 'list'}, {content: [{type: 'text', text: 'No sessions.'}]}, 'sessions', {blockable: true});
  fixture.invoke('web_fetch', {url: 'https://docs.python.org/3/library/csv.html'}, {content: [{type: 'text', text: 'csv'}]}, 'docs', {blockable: true});
  fixture.invoke('read', {path: 'expense-report/missing.csv'}, {isError: true, content: [{type: 'text', text: 'ENOENT'}]}, 'missing', {blockable: true});
  fixture.invoke('read', {path: 'expense-report/public/index.html'}, {content: [{type: 'text', text: 'Expense report'}]}, 'readback');
  const delivered = await finalAnswer(fixture);
  assert.equal(delivered.status, 'passed');
  assert.doesNotMatch(delivered.text, STALE);
});
