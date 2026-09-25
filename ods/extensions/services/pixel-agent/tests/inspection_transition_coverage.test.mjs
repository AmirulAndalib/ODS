// Replays laptop round 100 (Qwen3.5-9B, ODS main b060c6ae): the owner asked
// for the Midnight sold-out concert card to start hidden and a button named
// exactly "Show sold out" to reveal it. The model published, then inspected
// assert-visible(button), click(button), assert-visible(".event-card.sold-out.revealed")
// and the tool answered "Preview inspection passed" with a caveat. The model
// said "fully verified"; finalization then failed the delivery. OpenClaw
// 2026.6.33 drops before_agent_finalize revisions after a plugin tool call,
// so the inspection result itself must say what to run next.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createToolLoopGuard} from '../plugin/tool-loop-guard.mjs';
import {extractRequestedLiterals, publishedHeadingName} from '../plugin/requested-literals.mjs';
import {PREVIEW_INSPECTION_TOOL, boundVisibilityInspection, requestedVisibilityTransition, inheritedVisibilityTransition}
  from '../plugin/preview-interaction-assurance.mjs';
import {INSPECTION_KIND, INSPECTION_SCOPE, TRANSITION_UNTESTED, createWorkspacePreviewInspectTool, inspectionPlanHash,
  normalizeWorkspacePreviewInspectionParams, transitionCorrection} from '../plugin/workspace-preview-inspect.mjs';

const LAPTOP = JSON.parse(fs.readFileSync(new URL('./inspection-transition-laptop-round100.json', import.meta.url), 'utf8'));
const [CREATE, UPDATE] = LAPTOP.turns;
const byTool = (turn, tool) => turn.calls.find(call => call.tool === tool);
const WRITE = byTool(CREATE, 'write');
const PUBLISH = byTool(CREATE, 'pixel_ods_workspace_preview');
const INSPECT = byTool(CREATE, PREVIEW_INSPECTION_TOOL);
const EDIT = byTool(UPDATE, 'edit');
const PUBLISH_UPDATE = byTool(UPDATE, 'pixel_ods_workspace_preview');
const INSPECT_UPDATE = byTool(UPDATE, PREVIEW_INSPECTION_TOOL);
const DIRECTORY = PUBLISH.arguments.relativeDirectory;
const FILE = `${DIRECTORY}/index.html`;
const ORIGINAL = WRITE.arguments.content;
const EDITED = EDIT.arguments.edits.reduce((html, edit) => html.replace(edit.oldText, () => edit.newText), ORIGINAL);
const USER = 'ods-0fdc5c88412e45b221b82cb81b6b52defcdc7e7a4e5966956292889409ebf8ac';
const SESSION = {agentId: 'pixel', sessionId: 'a7094eff-f48e-425d-a609-276b188e127d', sessionKey: `agent:pixel:openai-user:${USER}`};
const HEADING = {role: 'heading', name: 'Midnight Sold-Out Concert', exact: true};
const BUTTON = {role: 'button', name: 'Show sold out', exact: true};
const CORRECT_STEPS = [{action: 'assert-hidden', locator: HEADING}, {action: 'click', locator: BUTTON},
  {action: 'assert-visible', locator: HEADING}];
const INCOMPLETE = 'Preview inspection INCOMPLETE - not verified.';

function digest(html) {
  const name = Buffer.from('index.html'), data = Buffer.from(html), a = Buffer.alloc(4), b = Buffer.alloc(8);
  a.writeUInt32BE(name.length); b.writeBigUInt64BE(BigInt(data.length));
  return createHash('sha256').update(a).update(name).update(b).update(data).digest('hex');
}

// The recorded page as the capsule measured it: the button is always shown;
// the card (and its heading) has visibility:hidden and opacity 0 until the
// click adds .revealed. Only the recorded site's locators exist.
const shown = visible => ({count: 1, visible, display: 'block', visibility: visible ? 'visible' : 'hidden',
  opacity: visible ? '1' : '0', hidden: false, hiddenUntilFound: false, rectCount: 1});
// It receives the tool's normalized request, as the broker does.
function laptopCapsule(request) {
  const recorded = [INSPECT, INSPECT_UPDATE].find(call => call.details.planSha256 === inspectionPlanHash(request));
  if (recorded) return structuredClone(recorded.details);
  let revealed = false;
  const measure = locator => locator.role === 'button' && locator.name === 'Show sold out' ? shown(true)
    : locator.role === 'heading' && locator.name === 'Midnight Sold-Out Concert' ? shown(revealed)
      : locator.selector === '.event-card.sold-out.revealed' && revealed ? shown(true) : {count: 0};
  const steps = [];
  for (const [index, step] of request.steps.entries()) {
    const item = {index, ...step, before: measure(step.locator), stable: true, status: 'failed'};
    if (item.before.count !== 1) item.errorCode = 'no_match';
    else if (step.action === 'click') { revealed = true; Object.assign(item, {after: measure(step.locator), status: 'passed'}); }
    else if (item.before.visible === (step.action === 'assert-visible')) item.status = 'passed';
    else item.errorCode = 'visibility_mismatch';
    steps.push(item);
    if (item.status === 'failed') break;
  }
  return {schemaVersion: 1, kind: INSPECTION_KIND,
    status: steps.length === request.steps.length && steps.every(step => step.status === 'passed') ? 'passed' : 'failed',
    siteId: request.siteId, sha256: request.sha256, planSha256: inspectionPlanHash(request), viewport: request.viewport, steps,
    diagnostics: {renderedHiddenAttributeCount: 0, hiddenUntilFoundCount: 0}, blockedRequests: [], scope: INSPECTION_SCOPE};
}

const envelope = (name, result) => ({content: [{type: 'text', text: JSON.stringify({tool: {id: `openclaw:pixel-ods:${name}`, name}, result})}],
  details: {tool: {id: `openclaw:pixel-ods:${name}`, source: 'openclaw', sourceName: 'pixel-ods', name}, result}});

function replay(t, {nestedHooks = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-transition-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const guard = createToolLoopGuard({workspacePreviewInspectionAvailable: true, abortRun: () => true});
  const tool = createWorkspacePreviewInspectTool({request: async params => laptopCapsule(params),
    transitionRequirement: (toolCallId, params) => guard.previewInspectionTransition(toolCallId, params)});
  let context;
  const begin = turn => {
    context = {...SESSION, runId: turn.runId};
    guard.observeRun(context, 'pixel', {prompt: turn.prompt}, {workspaceRoot: root});
  };
  const invoke = (name, args, id, result) => {
    const ctx = {...context, toolName: name, toolCallId: id};
    const event = {toolName: name, runId: context.runId, toolCallId: id, params: args};
    const prepared = guard.beforeToolCall(event, ctx);
    assert.notEqual(prepared?.block, true, prepared?.blockReason);
    guard.afterToolCall({...event, params: prepared?.params ?? args, result}, ctx);
    guard.toolResultPersist({toolName: name, toolCallId: id, message: {role: 'toolResult', toolName: name, toolCallId: id, ...result}}, ctx);
  };
  const disk = html => { fs.mkdirSync(path.join(root, DIRECTORY), {recursive: true}); fs.writeFileSync(path.join(root, FILE), html); };
  const write = (html, id) => { disk(html); invoke('write', {path: FILE, content: html}, id,
    {content: [{type: 'text', text: `Successfully wrote ${Buffer.byteLength(html)} bytes to ${FILE}`}]}); };
  const edit = (before, after, id) => {
    invoke('read', {path: FILE}, `${id}-read`, {content: [{type: 'text', text: before}]});
    disk(after);
    invoke('edit', EDIT.arguments, id, {content: [{type: 'text', text: `Successfully replaced ${EDIT.arguments.edits.length} block(s) in ${FILE}.`}]});
  };
  // Tool Search transport as the laptop model used it: tool_call with the bare id.
  const publish = (call, id) => invoke('tool_call', {id: 'pixel_ods_workspace_preview', args: call.arguments}, id,
    envelope('pixel_ods_workspace_preview', {content: [{type: 'text', text: 'ODS independently published and read back 1 workspace static files.'}],
      details: call.details}));
  const inspect = async (args, id) => {
    const outer = {id: PREVIEW_INSPECTION_TOOL, args};
    const ctx = {...context, toolName: 'tool_call', toolCallId: id};
    const event = {toolName: 'tool_call', runId: context.runId, toolCallId: id, params: outer};
    const prepared = guard.beforeToolCall(event, ctx);
    assert.notEqual(prepared?.block, true, prepared?.blockReason);
    const child = `tool_search_code:${id}:${PREVIEW_INSPECTION_TOOL}:1`;
    const childCtx = {...context, toolName: PREVIEW_INSPECTION_TOOL, toolCallId: child};
    const childEvent = {toolName: PREVIEW_INSPECTION_TOOL, runId: context.runId, toolCallId: child, params: args};
    if (nestedHooks) assert.notEqual(guard.beforeToolCall(childEvent, childCtx)?.block, true);
    const inner = await tool.execute(child, args);
    if (nestedHooks) guard.afterToolCall({...childEvent, result: inner}, childCtx);
    const result = envelope(PREVIEW_INSPECTION_TOOL, inner);
    guard.afterToolCall({...event, params: prepared?.params ?? outer, result}, ctx);
    guard.toolResultPersist({toolName: 'tool_call', toolCallId: id, message: {role: 'toolResult', toolName: 'tool_call', toolCallId: id, ...result}}, ctx);
    return inner;
  };
  const verification = () => guard.verificationForRun(context.runId);
  return {guard, begin, write, edit, publish, inspect, verification};
}

// The model-visible corrective arguments, exactly as a small model would copy them.
const nextArgs = text => {
  const match = /with exactly these args: (\{.*?\}) The target is /.exec(text);
  assert.ok(match, text);
  return JSON.parse(match[1]);
};

for (const nestedHooks of [false, true]) {
  test(`round 100 replay: the recorded inspection is INCOMPLETE and names the exact next steps (nested hooks: ${nestedHooks})`, async t => {
    const r = replay(t, {nestedHooks});
    r.begin(CREATE);
    r.write(ORIGINAL, 'write');
    assert.equal(digest(ORIGINAL), PUBLISH.details.sha256, 'replayed bytes reproduce the host snapshot digest');
    r.publish(PUBLISH, 'publish');
    const recorded = await r.inspect(INSPECT.arguments, 'IYwsoY7zuV9hOyslObSkIqc1uUF4rO14');
    const text = recorded.content[0].text;
    // Before: "Preview inspection passed. Only the listed steps passed; ..."
    assert.match(INSPECT.text, /^Preview inspection passed\. Only the listed steps passed; no show\/hide transition was tested\./);
    assert.ok(text.startsWith(`${INCOMPLETE} The owner requested a show/hide change, but these steps never asserted one element ` +
      'with opposite visibility before and after a click, so the requested interaction was not tested. ' +
      'Missing: assert-hidden of the affected element before the click and assert-visible of that same element after it.'), text);
    assert.doesNotMatch(text, /Preview inspection passed/);
    assert.equal(recorded.isError, true);
    assert.deepEqual({status: recorded.details.status, errorCode: recorded.details.errorCode, kind: recorded.details.kind},
      {status: 'incomplete', errorCode: TRANSITION_UNTESTED, kind: INSPECTION_KIND});
    assert.deepEqual(recorded.details.receipt, INSPECT.details, 'the capsule receipt is kept unchanged as evidence');
    assert.ok(text.includes(`"siteId":"${PUBLISH.details.siteId}","status":"incomplete","steps":[`), 'the evidence copy never reads passed');
    // Ready to send: the model's own control and the published card heading.
    const args = nextArgs(text);
    assert.deepEqual(args, {siteId: PUBLISH.details.siteId, sha256: PUBLISH.details.sha256,
      viewport: INSPECT.arguments.viewport, steps: CORRECT_STEPS});
    assert.ok(text.includes('The target is the heading "Midnight Sold-Out Concert" of the requested "Midnight sold-out concert" element, ' +
      'read from the published source'), text);
    assert.ok(text.includes('Do not change the site only for this check, and do not say the interaction works until an inspection with these steps passes.'));
    assert.equal(boundVisibilityInspection(INSPECT.arguments, recorded, PUBLISH.details), undefined);
    assert.equal(r.verification().status, 'failed');
    assert.match(r.verification().text, /show\/hide interaction/);
    // Sending exactly those args passes on the recorded page and verifies it.
    const corrected = await r.inspect(args, 'corrected');
    assert.equal(corrected.isError, undefined);
    assert.equal(corrected.details.status, 'passed');
    assert.match(corrected.content[0].text, /^Preview inspection passed\. These steps tested opposite visibility states of the same element around a click\./);
    assert.equal(r.verification().status, 'passed');
    // A later read-only check of the same snapshot keeps that proof and is not incomplete.
    const footer = await r.inspect({...args, steps: [{action: 'assert-visible', locator: BUTTON}]}, 'static-after');
    assert.equal(footer.details.status, 'passed');
    assert.doesNotMatch(footer.content[0].text, /INCOMPLETE/);
    assert.equal(r.verification().status, 'passed');
  });
}

for (const nestedHooks of [false, true])
test(`round 100 update turn: the preserved behavior keeps the card target on the edited snapshot (nested hooks: ${nestedHooks})`, async t => {
  const r = replay(t, {nestedHooks});
  r.begin(CREATE);
  r.write(ORIGINAL, 'write');
  r.publish(PUBLISH, 'publish');
  await r.inspect({...INSPECT.arguments, steps: CORRECT_STEPS}, 'transition');
  assert.equal(r.verification().status, 'passed');
  r.begin(UPDATE);
  r.edit(ORIGINAL, EDITED, 'edit');
  assert.equal(digest(EDITED), PUBLISH_UPDATE.details.sha256, 'replayed edits reproduce the updated snapshot digest');
  r.publish(PUBLISH_UPDATE, 'publish-update');
  const recorded = await r.inspect(INSPECT_UPDATE.arguments, 'inspect-update');
  assert.ok(recorded.content[0].text.startsWith(INCOMPLETE), recorded.content[0].text);
  assert.deepEqual(nextArgs(recorded.content[0].text), {siteId: PUBLISH_UPDATE.details.siteId, sha256: PUBLISH_UPDATE.details.sha256,
    viewport: INSPECT_UPDATE.arguments.viewport, steps: CORRECT_STEPS});
  assert.equal(r.verification().status, 'failed');
  await r.inspect(nextArgs(recorded.content[0].text), 'inspect-update-corrected');
  assert.equal(r.verification().status, 'passed');
});

test('a request without show/hide behavior keeps an ordinary passing inspection', async t => {
  const r = replay(t);
  r.begin({...CREATE, prompt: CREATE.prompt.replace(/ Initially hide[^.]*\. Provide[^.]*\./, '')});
  r.write(ORIGINAL, 'write');
  r.publish(PUBLISH, 'publish');
  const result = await r.inspect(INSPECT.arguments, 'inspect');
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, 'passed');
  assert.equal(result.content[0].text, INSPECT.text, 'byte-identical to the recorded result');
});

test('the requirement binds only to the exact pending inspection call of the active run', async t => {
  const r = replay(t);
  r.begin(CREATE);
  r.write(ORIGINAL, 'write');
  r.publish(PUBLISH, 'publish');
  assert.equal(r.guard.previewInspectionTransition('unknown', INSPECT.arguments), undefined);
  const ctx = {...SESSION, runId: CREATE.runId, toolName: 'tool_call', toolCallId: 'outer'};
  r.guard.beforeToolCall({toolName: 'tool_call', runId: CREATE.runId, toolCallId: 'outer',
    params: {id: PREVIEW_INSPECTION_TOOL, args: INSPECT.arguments}}, ctx);
  const child = `tool_search_code:outer:${PREVIEW_INSPECTION_TOOL}:1`;
  assert.deepEqual(r.guard.previewInspectionTransition(child, INSPECT.arguments), {target: 'Midnight sold-out concert',
    heading: 'Midnight Sold-Out Concert', control: {role: 'button', name: 'Show sold out'}, initiallyHidden: true});
  assert.equal(r.guard.previewInspectionTransition(child, {...INSPECT.arguments, viewport: {width: 800, height: 600}}), undefined,
    'different arguments are a different call');
  assert.equal(r.guard.previewInspectionTransition(`tool_search_code:other:${PREVIEW_INSPECTION_TOOL}:1`, INSPECT.arguments), undefined);
  // Another snapshot of the same run gets the owner's phrase, not this snapshot's heading.
  const other = {...INSPECT.arguments, sha256: 'b'.repeat(64), siteId: `site-${'b'.repeat(24)}`};
  r.guard.beforeToolCall({toolName: PREVIEW_INSPECTION_TOOL, runId: CREATE.runId, toolCallId: 'direct', params: other},
    {...SESSION, runId: CREATE.runId, toolName: PREVIEW_INSPECTION_TOOL, toolCallId: 'direct'});
  assert.equal(r.guard.previewInspectionTransition('direct', other).heading, undefined);
  assert.equal(r.guard.previewInspectionTransition('direct', other).target, 'Midnight sold-out concert');
  // Inspection unavailable on this host: no requirement at all.
  const off = createToolLoopGuard({workspacePreviewInspectionAvailable: false, abortRun: () => true});
  assert.equal(off.previewInspectionTransition('direct', other), undefined);
});

const request = steps => normalizeWorkspacePreviewInspectionParams({siteId: PUBLISH.details.siteId, sha256: PUBLISH.details.sha256,
  viewport: {width: 375, height: 667}, steps});
const passing = params => laptopCapsule(params);

test('tool: genuine transitions and failures never consult the requirement', async () => {
  let consulted = 0;
  const tool = createWorkspacePreviewInspectTool({request: async params => passing(params), transitionRequirement: () => {
    consulted += 1; return {target: 'Midnight sold-out concert', initiallyHidden: true}; }});
  const base = {siteId: PUBLISH.details.siteId, sha256: PUBLISH.details.sha256, viewport: {width: 375, height: 667}};
  const good = await tool.execute('good', {...base, steps: CORRECT_STEPS});
  assert.equal(good.details.status, 'passed');
  assert.equal(good.isError, undefined);
  const reverse = await tool.execute('reverse', {...base, steps: [{action: 'assert-hidden', locator: HEADING},
    {action: 'click', locator: BUTTON}, {action: 'assert-visible', locator: HEADING}, {action: 'assert-visible', locator: BUTTON}]});
  assert.equal(reverse.details.status, 'passed');
  const failed = await tool.execute('failed', {...base, steps: [{action: 'assert-visible', locator: HEADING}]});
  assert.equal(failed.details.status, 'failed');
  assert.doesNotMatch(failed.content[0].text, /INCOMPLETE/);
  assert.equal(consulted, 0);
  // A throwing or absent requirement leaves the ordinary result unchanged.
  const throwing = createWorkspacePreviewInspectTool({request: async params => passing(params), transitionRequirement: () => { throw Error('x'); }});
  assert.equal((await throwing.execute('x', INSPECT.arguments)).content[0].text, INSPECT.text);
  const plain = createWorkspacePreviewInspectTool({request: async params => passing(params)});
  assert.equal((await plain.execute('x', INSPECT.arguments)).content[0].text, INSPECT.text);
});

test('tool: corrective steps fall back from the published heading to the model and owner wording', () => {
  const laptop = request(INSPECT.arguments.steps);
  const own = transitionCorrection(laptop, {target: 'Midnight sold-out concert', initiallyHidden: true});
  assert.equal(own.basis, 'own');
  assert.deepEqual(own.args.steps.map(step => step.locator), [{selector: '.event-card.sold-out.revealed'}, BUTTON,
    {selector: '.event-card.sold-out.revealed'}]);
  const staticPlan = request([{action: 'assert-visible', locator: BUTTON}]);
  const owner = transitionCorrection(staticPlan, {target: 'Midnight sold-out concert', control: {role: 'button', name: 'Show sold out'}, initiallyHidden: true});
  assert.equal(owner.basis, 'owner');
  assert.deepEqual(owner.args.steps, [{action: 'assert-hidden', locator: {role: 'heading', name: 'Midnight sold-out concert', exact: true}},
    {action: 'click', locator: BUTTON}, {action: 'assert-visible', locator: {role: 'heading', name: 'Midnight sold-out concert', exact: true}}]);
  // Hide-on-click wording reverses the assertions.
  const reverse = transitionCorrection(laptop, {heading: 'Welcome back', initiallyHidden: false});
  assert.deepEqual(reverse.args.steps.map(step => step.action), ['assert-visible', 'click', 'assert-hidden']);
  // Without a control or a target there is nothing ready to send.
  assert.equal(transitionCorrection(staticPlan, {target: 'Midnight sold-out concert', initiallyHidden: true}).args, undefined);
  assert.equal(transitionCorrection(request([{action: 'click', locator: BUTTON}]), {initiallyHidden: true}).args, undefined);
  // An oversized name cannot become a locator.
  assert.equal(transitionCorrection(staticPlan, {heading: 'x'.repeat(121), control: {role: 'button', name: 'Go'}, initiallyHidden: true}).args, undefined);
});

test('tool: an incomplete result without ready arguments still names the missing steps', async () => {
  const tool = createWorkspacePreviewInspectTool({request: async params => passing(params), transitionRequirement: () => ({initiallyHidden: true})});
  const result = await tool.execute('static', {...INSPECT.arguments, steps: [{action: 'assert-visible', locator: BUTTON}]});
  assert.equal(result.isError, true);
  assert.equal(result.details.status, 'incomplete');
  assert.match(result.content[0].text, /^Preview inspection INCOMPLETE - not verified\./);
  assert.match(result.content[0].text, /steps assert-hidden\(target\), click\(control\), assert-visible\(target\), using the same target locator in both assertions/);
  assert.doesNotMatch(result.content[0].text, /exactly these args/);
});

test('owner wording names the affected element, the control and the direction', () => {
  const derive = prompt => requestedVisibilityTransition(prompt, extractRequestedLiterals(prompt));
  assert.deepEqual(derive(CREATE.prompt), {target: 'Midnight sold-out concert', control: {role: 'button', name: 'Show sold out'},
    initiallyHidden: true});
  // "a visible footer" is content, and "Show sold out behavior" names no element.
  assert.deepEqual(derive(UPDATE.prompt), {initiallyHidden: true});
  assert.deepEqual(derive('Build a page. Add a button named "Dismiss" that hides the banner when clicked.'),
    {control: {role: 'button', name: 'Dismiss'}, initiallyHidden: false});
  assert.deepEqual(derive('Add a link called "More" that reveals the details. Do not hide the "Contact us" heading.'),
    {control: {role: 'link', name: 'More'}, initiallyHidden: true});
  assert.equal(derive('Create a static page with a heading titled "Hello".'), undefined);
  const inherited = derive(CREATE.prompt);
  assert.deepEqual(inheritedVisibilityTransition(derive(UPDATE.prompt), inherited), inherited);
  assert.equal(inheritedVisibilityTransition(inherited, undefined), inherited);
});

test('published heading names are exact, unique and bound to the snapshot bytes', t => {
  const preview = {relativeDirectory: DIRECTORY, files: 1, bytes: Buffer.byteLength(ORIGINAL), sha256: digest(ORIGINAL), siteId: PUBLISH.details.siteId};
  const tracked = html => new Map([[FILE, html]]);
  assert.equal(publishedHeadingName('Midnight sold-out concert', preview, {trackedContent: tracked(ORIGINAL)}), 'Midnight Sold-Out Concert');
  assert.equal(publishedHeadingName('Midnight sold-out concert', preview, {trackedContent: tracked(`${ORIGINAL} `)}), undefined,
    'bytes that do not reproduce the snapshot digest are never read');
  const page = html => {
    const bound = {...preview, bytes: Buffer.byteLength(html), sha256: digest(html)};
    return publishedHeadingName('Midnight sold-out concert', bound, {trackedContent: tracked(html)});
  };
  assert.equal(page('<h3 aria-label="Midnight sold-out concert (sold out)">Midnight sold-out concert</h3>'), 'Midnight sold-out concert (sold out)');
  assert.equal(page('<h3 aria-labelledby="x">Midnight sold-out concert</h3>'), undefined);
  assert.equal(page('<h3>Midnight   sold-out\n concert</h3>'), 'Midnight sold-out concert');
  assert.equal(page('<h3>Midnight sold-out concert</h3><h4>Midnight Sold-Out Concert</h4>'), undefined, 'two headings are not one locator');
  assert.equal(page('<p>Midnight sold-out concert</p>'), undefined);
  // The workspace copy is read only when it reproduces the digest.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-heading-name-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, DIRECTORY), {recursive: true});
  fs.writeFileSync(path.join(root, FILE), ORIGINAL);
  assert.equal(publishedHeadingName('Midnight sold-out concert', preview, {workspaceRoot: root}), 'Midnight Sold-Out Concert');
});

test('the registered inspection tool asks the run guard about exactly its own call', async () => {
  // Source composition only: the registration block, without the OpenClaw SDK.
  const source = fs.readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('    if (["unix", "native"].includes(api.pluginConfig?.workspacePreviewInspectionTransport)) {');
  const close = '\n    }\n';
  const end = source.indexOf(close, start);
  assert.ok(start >= 0 && end > start, 'expected the inspection tool registration block');
  let registered;
  const asked = [];
  vm.runInNewContext(source.slice(start, end + close.length), {
    api: {pluginConfig: {workspacePreviewInspectionTransport: 'unix'}},
    registerTool: (_api, tool, options) => { registered = {tool, names: [...options.names]}; },
    createWorkspacePreviewInspectTool: options => createWorkspacePreviewInspectTool({...options, request: async params => laptopCapsule(params)}),
    toolLoopGuard: {previewInspectionTransition: (id, params) => {
      asked.push([id, params]);
      return {target: 'Midnight sold-out concert', heading: 'Midnight Sold-Out Concert', initiallyHidden: true};
    }},
  });
  assert.deepEqual(registered.names, [PREVIEW_INSPECTION_TOOL]);
  const result = await registered.tool.execute('call-1', INSPECT.arguments);
  assert.deepEqual(asked, [['call-1', INSPECT.arguments]]);
  assert.ok(result.content[0].text.startsWith(INCOMPLETE), result.content[0].text);
  assert.deepEqual(nextArgs(result.content[0].text).steps, CORRECT_STEPS);
});
