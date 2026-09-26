import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {routePlaygroundTool} from '../plugin/playground-projects.mjs';
import {createToolLoopGuard} from '../plugin/tool-loop-guard.mjs';

const CORRECTION = /^For a new project, use a workspace-relative path such as Playground\/snake-game\/index\.html/;

function fixture(t, intent = 'build me a todo app i can use in the browser') {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ods-playground-spelling-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const state = {};
  const call = (tool, params, overrides = {}) => routePlaygroundTool({state, tool, params, root, session:'owner-session', intent, ...overrides});
  return {root, state, call};
}
const caseInsensitive = root => {
  const probe = path.join(root, 'Case-Probe');
  fs.mkdirSync(probe);
  try { return fs.existsSync(path.join(root, 'case-probe')); } finally { fs.rmdirSync(probe); }
};

test('first new-project write with a Playground misspelling proceeds to the canonical project path', t => {
  const variants = [
    'playground/todo-app/index.html',
    '/playground/todo-app/index.html',
    '/Playground/todo-app/index.html',
    'PLAYGROUND/todo-app/index.html',
    './playground/todo-app/index.html',
    '/workspace/playground/todo-app/index.html',
    'playground\\todo-app\\index.html',
  ];
  for (const value of [...variants, 'ROOT/playground/todo-app/index.html']) {
    for (const wrapped of [false, true]) {
      const {root, state, call} = fixture(t);
      const raw = value.replace('ROOT', root);
      const args = {path:raw, content:'<!doctype html><html></html>'};
      const decision = wrapped ? call('tool_call', {id:'openclaw:core:write', args}) : call('write', args);
      assert.notEqual(decision?.block, true, `${raw}: ${decision?.blockReason}`);
      const actual = wrapped ? decision.params.args : decision.params;
      assert.equal(actual.path, 'Playground/todo-app/index.html', raw);
      assert.equal(actual.content, args.content);
      assert.equal(args.path, raw, 'caller params are not mutated');
      assert.equal(state.binding.directory, 'Playground/todo-app');
      assert.ok(fs.lstatSync(path.join(root, 'Playground/todo-app')).isDirectory());
    }
  }
});

test('Playground misspellings that are not a descriptive project path keep the correction', t => {
  for (const value of [
    'playground/index.html',
    '/playground/index.html',
    'playground/project/index.html',
    '/playground/app/index.html',
    'playground/src/main.js',
    '/playground/CON/index.html',
    'playground/../outside/index.html',
    '/playground/todo-app/../../outside.html',
    '//playground/todo-app/index.html',
    '/tmp/playground/todo-app/index.html',
    '/home/owner/playground/todo-app/index.html',
    '/playgrounds/todo-app/index.html',
  ]) {
    const {root, state, call} = fixture(t);
    const decision = call('write', {path:value, content:'x'});
    assert.equal(decision?.block, true, value);
    assert.match(decision.blockReason, CORRECTION, value);
    assert.equal(state.binding ?? null, null, value);
    assert.equal(fs.existsSync(path.join(root, 'Playground')), false, value);
  }
});

test('a distinct lowercase playground entry makes the spelling ambiguous and keeps the correction', t => {
  {
    const {root, call} = fixture(t);
    const insensitive = caseInsensitive(root);
    fs.mkdirSync(path.join(root, 'playground'));
    fs.writeFileSync(path.join(root, 'playground/keep.txt'), 'keep');
    const decision = call('write', {path:'playground/todo-app/index.html', content:'x'});
    if (insensitive) {
      // One folder entry: the spelling names the same Playground folder.
      assert.equal(decision.params.path, 'Playground/todo-app/index.html');
    } else {
      assert.equal(decision?.block, true);
      assert.match(decision.blockReason, CORRECTION);
      assert.equal(fs.existsSync(path.join(root, 'Playground')), false);
    }
    assert.equal(fs.readFileSync(path.join(root, 'playground/keep.txt'), 'utf8'), 'keep');
  }
  {
    const {root, call} = fixture(t);
    const outside = fs.mkdtempSync(path.join(tmpdir(), 'ods-playground-outside-'));
    t.after(() => fs.rmSync(outside, {recursive:true, force:true}));
    fs.symlinkSync(outside, path.join(root, 'playground'), 'junction');
    const decision = call('write', {path:'/playground/todo-app/index.html', content:'x'});
    assert.equal(decision?.block, true);
    assert.deepEqual(fs.readdirSync(outside), []);
  }
});

test('owner-named, non-project and already canonical paths are never rewritten by the spelling rule', t => {
  for (const intent of [
    'Build a todo app in playground/todo-app/index.html.',
    'Build a todo app at /playground/todo-app/index.html.',
    'Create a todo app in the folder playground.',
  ]) {
    const {root, call} = fixture(t, intent);
    const value = intent.includes('/playground/') ? '/playground/todo-app/index.html' : 'playground/todo-app/index.html';
    assert.equal(call('write', {path:value, content:'x'}), undefined, intent);
    assert.equal(fs.existsSync(path.join(root, 'Playground')), false, intent);
  }
  {
    // Routing is inactive for an ordinary request without a bound project.
    const {root, call} = fixture(t, 'Summarize my notes.');
    for (const tool of ['write', 'edit', 'read']) assert.equal(call(tool, {path:'/playground/todo-app/index.html'}), undefined, tool);
    assert.equal(call('pixel_ods_workspace_preview', {relativeDirectory:'playground/todo-app'}), undefined);
    assert.equal(call('exec', {command:'ls', workdir:'playground/todo-app'}), undefined);
    assert.equal(fs.existsSync(path.join(root, 'Playground')), false);
  }
  {
    const {call} = fixture(t);
    assert.equal(call('write', {path:'Playground/todo-app/index.html', content:'x'}), undefined, 'canonical first write is unchanged');
  }
});

test('later write, edit, read, preview and exec calls agree on the bound project for every spelling', t => {
  for (const collision of [false, true]) {
    const {root, call} = fixture(t);
    if (collision) fs.mkdirSync(path.join(root, 'Playground/todo-app'), {recursive:true});
    const directory = collision ? 'Playground/todo-app-2' : 'Playground/todo-app';
    assert.equal(call('write', {path:'/playground/todo-app/index.html', content:'x'}).params.path, `${directory}/index.html`);
    const cases = [
      ['write', {path:'playground/todo-app/app.js', content:'y'}, 'path', `${directory}/app.js`],
      ['write', {path:'/Playground/todo-app/style.css', content:'z'}, 'path', `${directory}/style.css`],
      ['edit', {path:'/playground/todo-app/index.html', oldText:'x', newText:'w'}, 'path', `${directory}/index.html`],
      ['read', {path:'playground/todo-app/index.html'}, 'path', `${directory}/index.html`],
      ['pixel_ods_workspace_preview', {relativeDirectory:'playground/todo-app'}, 'relativeDirectory', directory],
      ['pixel_ods_workspace_preview', {relativeDirectory:'/playground/todo-app'}, 'relativeDirectory', directory],
      ['exec', {command:'ls', workdir:'playground/todo-app'}, 'workdir', `/workspace/${directory}`],
      ['exec', {command:'ls', workdir:'/workspace/playground/todo-app'}, 'workdir', `/workspace/${directory}`],
      ['exec', {command:'ls', workdir:'/playground/todo-app'}, 'workdir', `/workspace/${directory}`],
    ];
    for (const [tool, params, key, expected] of cases) {
      const decision = call(tool, params);
      assert.notEqual(decision?.block, true, `${tool} ${params[key]}: ${decision?.blockReason}`);
      assert.equal(decision.params[key], expected, `${tool} ${params[key]}`);
      const wrapped = call('tool_call', {id:tool === 'pixel_ods_workspace_preview' ? tool : `openclaw:core:${tool}`, args:params});
      assert.equal(wrapped.params.args[key], expected, `wrapped ${tool} ${params[key]}`);
    }
    const input = '*** Begin Patch\n*** Add File: playground/todo-app/extra.js\n+x\n*** Update File: /playground/todo-app/app.js\n@@\n-y\n+z\n*** End Patch';
    assert.equal(call('apply_patch', {input}).params.input,
      input.replace('Add File: playground/todo-app/', `Add File: ${directory}/`).replace('Update File: /playground/todo-app/', `Update File: ${directory}/`));
    // A misspelling of a different Playground project is not redirected.
    assert.equal(call('read', {path:'playground/other-app/index.html'}), undefined);
    assert.equal(call('pixel_ods_workspace_preview', {relativeDirectory:'playground/other-app'}), undefined);
    assert.equal(call('exec', {command:'ls', workdir:'playground/other-app'}), undefined);
    assert.deepEqual(fs.readdirSync(path.join(root, 'Playground')).sort(), collision ? ['todo-app', 'todo-app-2'] : ['todo-app']);
  }
});

test('replay: strixy todo-app sequence now writes Playground/todo-app/index.html on the first attempt', t => {
  // Recorded 2026-09-26 on strixy (Qwen3.6-35B-A3B), open prompt 02-todo-app:
  // write /playground/todo-app/index.html (8897 chars) -> correction,
  // write playground/todo-app/index.html (same) -> correction,
  // preview playground/todo-app -> refused, then the progress fuse stopped the
  // run with nothing saved. Each full-page write cost about 70 s of generation.
  const html = `<!DOCTYPE html><html lang="en"><head><title>Todo</title></head><body><h1>Todo</h1>${'<!-- pad -->'.repeat(800)}</body></html>`.slice(0, 8897 - 7) + '</html>';
  assert.equal(html.length, 8897);
  for (const executionHost of ['sandbox', 'gateway']) {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'ods-playground-replay-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    const context = {agentId:'pixel', runId:`strixy-todo-${executionHost}`, sessionId:'bdbc1086-5626-4cd3-8c6d-85920e61d3ec'};
    const guard = createToolLoopGuard();
    guard.observeRun(context, 'pixel', {prompt:'build me a todo app i can use in the browser'}, {workspaceRoot:root, executionHost});
    const run = (toolName, params, id) => {
      const decision = guard.beforeToolCall({toolName, toolCallId:id, params}, context);
      assert.notEqual(decision?.block, true, `${toolName}: ${decision?.blockReason}`);
      return decision?.params ?? params;
    };
    const written = {content:[{type:'text', text:'Successfully wrote 8897 bytes'}]};
    const first = run('write', {path:'/playground/todo-app/index.html', content:html}, 'NE5VNUkOws87AONddLQEYxRoyFC0iR3c');
    assert.equal(first.path, 'Playground/todo-app/index.html');
    assert.equal(first.content, html);
    fs.writeFileSync(path.join(root, first.path), first.content);
    guard.afterToolCall({toolName:'write', toolCallId:'NE5VNUkOws87AONddLQEYxRoyFC0iR3c', params:first, result:written}, context);
    // The recorded retry used the lowercase spelling. It now names the same
    // canonical file, so the unchanged content is recognized as a repeat.
    const second = guard.beforeToolCall({toolName:'write', toolCallId:'Y1Np60UHLrczn53j6RpbmMomAsmzXNpK',
      params:{path:'playground/todo-app/index.html', content:html}}, context);
    assert.equal(second?.block, true);
    assert.match(second.blockReason, /repeats content already recorded for this path/);
    const revised = run('write', {path:'playground/todo-app/index.html', content:html.replace('<h1>Todo</h1>', '<h1>Todos</h1>')}, 'revised-write');
    assert.equal(revised.path, 'Playground/todo-app/index.html');
    const preview = run('pixel_ods_workspace_preview', {relativeDirectory:'playground/todo-app'}, 'So7BuyO8Q9viw4SQtSYJtQKzYl4J7dD3');
    assert.equal(preview.relativeDirectory, 'Playground/todo-app');
    assert.deepEqual(fs.readdirSync(path.join(root, 'Playground')), ['todo-app']);
    assert.equal(fs.readFileSync(path.join(root, 'Playground/todo-app/index.html'), 'utf8'), html);
    if (!caseInsensitive(root)) assert.equal(fs.existsSync(path.join(root, 'playground')), false);
  }
});
