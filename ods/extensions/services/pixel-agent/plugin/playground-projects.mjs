// Project routing is an owner-workspace convention, never a new access grant.
// The core tools still enforce their normal sandbox and permission checks.
import * as fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';

const LIMIT = 256;
const MAX_STATE_BYTES = 2048;
const STATE_DIRECTORY = '.ods-projects';
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const GENERIC = /^(?:playground|project|projeto|app|application|site|website|web|game|jogo|public|src|source|build|dist|assets|static|css|js|test|tests|folder|new-project)$/i;
const LOCAL_FOLDERS = /^(?:src|source|public|assets|static|styles?|css|js|scripts?|tests?|docs?|lib|components|build|dist)$/i;
const CORRECTION = 'For a new project, use a workspace-relative path such as Playground/snake-game/index.html or Playground/weather-tool/main.py. Omit host home/workspace directory prefixes. Use that same descriptive folder for every project file and for preview publication. Do not use a bare filename or a generic src/public/project folder as the project name.';
// Names of a role, manifest, test, sample or scratch file, not a project.
// Matched on the lowercase kebab form; such names never become a suggestion.
const ROLE_FOLDER = /^(?:index|main|app|script|program|tool|run|utils?|helpers?|common|lib|setup|readme|conftest|config|settings|constants|manage|server|client|cli|demo|example|sample|temp|tmp|scratch|(?:tests?|spec)(?:-.*)?|.*-(?:tests?|spec))$/;
// Only a program or page file names a new project. Manifests such as
// package.json, requirements.txt or Makefile, documents and data do not.
const PROJECT_FILE = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|html?|sh|rb|go|rs|java|kt|swift|c|cc|cpp|cs|php|lua|pl|dart)$/i;
const NOT_RUN = 'Not run: write the first project file before running commands; write creates its folder, so mkdir is not needed.';

function parts(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const result = value.split('/');
  return result.length <= 12 && result.every(part => COMPONENT.test(part) && !part.endsWith('.') && !RESERVED.test(part)) ? result : null;
}
function plainIntent(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ');
}
export function requestsNewPlaygroundProject(intent) {
  // Filenames and path components are operands, not project-category words.
  // For example, creating macos-tool-check/probe.txt is not creating a tool.
  const text = plainIntent(intent).replace(/\b[A-Za-z0-9_]+(?:[-./\\][A-Za-z0-9_]+)+\b/g, ' ');
  // Continuation quotes the old creation request, not a new reservation.
  // Core tool policy still controls every inspection and mutation.
  if (/^\s*(?:\/goal\s+)?Continue the goal from the preceding conversation using the existing work\./i.test(text)) return false;
  const clauses = text.split(/[;!?\n]|\.(?=\s|$)/);
  return clauses.some(clause =>
    (/\b(?:create|build|develop|design|implement|generate|write|crie|criar|cria|construa|construir|desenvolva|desenvolver|implemente|gere|escreva)\b/i.test(clause)
      || /\bmake\s+(?:me\s+)?(?:a|an|new|another)\b|\b(?:faca|fazer|faz)\s+(?:um|uma|novo|nova|outro|outra)\b/i.test(clause))
    && /\b(?:project|projeto|site|website|webpage|app|application|aplicativo|aplicacao|game|jogo|joguinho|dashboard|landing\s+page|tool|ferramenta|program|programa|script|utility|utilitario|calculator|calculadora|timer|cronometro)\b/i.test(clause)
    && !/\b(?:do\s+not|don['’]t|never|without|nao|nunca|sem)\s+(?:(?:please|por\s+favor)\s+)?(?:create|build|make|develop|design|implement|generate|write|crie|criar|cria|construa|construir|faca|fazer|desenvolva|desenvolver|implemente|gere|escreva)\b/i.test(clause)
    && !/\b(?:explain|describe|tutorial|explique|descreva)\b/i.test(clause)
    && !/\b(?:existing|current|previous|existente|atual|anterior)\s+(?:project|projeto|site|app|game|jogo)\b/i.test(clause)
    && !/\b(?:for|in|inside|into|on|to|para|nesse|neste|desse|deste|no|na)\s+(?:(?:this|that|the|my|our|esse|este|meu|nosso|o|a)\s+)*(?:app|site|game|jogo|project|projeto|application|aplicativo)\b/i.test(clause));
}

// Explicit owner operands win over this default. This intentionally errs on
// preserving a path: changing an explicitly requested location is worse than
// leaving one new project outside Playground.
// A bare directory name after "workspace directory" is still an explicit
// owner operand. Match an affirmative creation clause, not an example, quoted
// instruction, or prohibition. This preserves the path; it grants no access.
function namesWorkspaceDirectory(text) {
  return text.split(/[;!?\n]|\.(?=\s|$)/).some(clause => {
    if (!/^\s*(?:please\s+)?(?:create|build|make|develop|design|implement|generate|write)\b/i.test(clause)) return false;
    const match = /\b(?:in|inside|under)\s+(?:(?:a|an|the)\s+)?(?:(?:new|separate|empty)\s+)?workspace\s+(?:directory|folder)\s+(?:(?:called|named)\s+)?(?:"([A-Za-z0-9][A-Za-z0-9._-]{0,63})"|'([A-Za-z0-9][A-Za-z0-9._-]{0,63})'|`([A-Za-z0-9][A-Za-z0-9._-]{0,63})`|([A-Za-z0-9][A-Za-z0-9._-]{0,63}))(?=$|[\s,;.!?])/i.exec(clause);
    if (!match || /\b(?:not|never|avoid|don't|don’t|example|e\.g\.)\b/i.test(clause.slice(0,match.index))) return false;
    const name = match.slice(1).find(Boolean);
    return Boolean(parts(name));
  });
}

function ownerNamesPath(intent) {
  const text = plainIntent(intent).replace(/https?:\/\/\S+/g, ' ');
  return namesWorkspaceDirectory(text) || /(?:^|[\s`"'(])(?:\/?[A-Za-z0-9_.-]+[\/\\][A-Za-z0-9_./\\-]+|[A-Za-z]:[\/\\]\S+)(?=$|[\s`"'),;.!?])/i.test(text)
    || /\b(?:folder|directory|pasta|diretorio)\s+(?:called|named|chamad[ao])\s+[`"']?[A-Za-z0-9_.-]+/i.test(text)
    || /\b(?:in|inside|under|em|na|no)\s+(?:the\s+)?(?:folder|directory|pasta|diretorio)\s+(?!with\b|for\b|com\b|para\b)[`"']?[A-Za-z0-9_.-]+/i.test(text);
}
function relative(value, root) {
  if (typeof value !== 'string') return null;
  let text = value.replaceAll('\\', '/');
  const configured = root.replaceAll('\\', '/').replace(/\/$/, '');
  if (text.startsWith(`${configured}/`)) text = text.slice(configured.length + 1);
  else if (text.startsWith('/workspace/')) text = text.slice('/workspace/'.length);
  if (text.startsWith('./')) text = text.slice(2);
  return parts(text) ? text : null;
}
// A folder name that describes a project: valid, not generic, not a role,
// test or sample name, and with at least three letters.
function descriptiveFolder(name) {
  const kebab = String(name).replace(/[._]+/g, '-').toLowerCase();
  return parts(name)?.length === 1 && !GENERIC.test(kebab) && !ROLE_FOLDER.test(kebab)
    && (kebab.match(/[a-z]/g) ?? []).length >= 3;
}
// The first name under Playground that nothing uses yet: the name itself or,
// with suffixes, the -2, -3 ... names that reserveProject would choose. A
// suggestion never names an existing folder, which may be an owner project.
// Nothing is created. Null when the workspace cannot be checked, so advice
// never affects routing.
function freeFolder(root, name, suffixes = false) {
  try {
    const base = path.join(safeRoot(root),'Playground');
    try { const stat = fs.lstatSync(base); if (!stat.isDirectory() || stat.isSymbolicLink()) return null; }
    catch (error) { return error.code === 'ENOENT' ? name : null; }
    for (let i = 1; i <= (suffixes ? 1000 : 1); i++) {
      const candidate = i === 1 ? name : `${name.slice(0,58)}-${i}`;
      try { fs.lstatSync(path.join(base,candidate)); }
      catch (error) { return error.code === 'ENOENT' ? candidate : null; }
    }
  } catch { /* An unavailable workspace gets no suggestion. */ }
  return null;
}
// The folder already suggested in this run, while it is still unused. Later
// refusals repeat it, so one run never gets two different project folders.
function earlierFolder(state, root) {
  return state.suggestedFolder && freeFolder(root,state.suggestedFolder) === state.suggestedFolder ? state.suggestedFolder : null;
}
// Advice for a refused fresh-project write whose target is one file name,
// such as /workspace/PhotoRenamer.py -> Playground/photo-renamer/PhotoRenamer.py.
// Returns null when no descriptive, unused folder follows from the name. The
// caller's path is never rewritten: the model sends the suggested path itself.
function suggestedProjectPath(value, root, state) {
  if (typeof value !== 'string') return null;
  let text = value.replaceAll('\\', '/');
  const configured = root.replaceAll('\\', '/').replace(/\/$/, '');
  if (text.startsWith(`${configured}/`)) text = text.slice(configured.length + 1);
  else if (text.startsWith('/workspace/')) text = text.slice('/workspace/'.length);
  else if (text.startsWith('/')) text = text.slice(1);
  if (text.startsWith('./')) text = text.slice(2);
  if (parts(text)?.length !== 1) return null;
  const earlier = earlierFolder(state,root);
  if (earlier) return `Playground/${earlier}/${text}`;
  if (!PROJECT_FILE.test(text)) return null;
  const folder = text.slice(0, text.lastIndexOf('.')).replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[._]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').toLowerCase();
  if (!descriptiveFolder(folder)) return null;
  const free = freeFolder(root,folder,true);
  return free ? `Playground/${free}/${text}` : null;
}
// The first descriptive, unused Playground/<name> that a refused command names.
function commandProjectFolder(command, root) {
  for (const match of command.matchAll(/(?:^|[\s"'`=:(/])Playground\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=$|[\s/"'`;&|)])/g)) {
    if (descriptiveFolder(match[1]) && freeFolder(root,match[1]) === match[1]) return match[1];
  }
  return null;
}
// A command whose first step is cd into the bound project directory, written
// relative to the workspace (optionally ./ and a trailing /), and followed by
// the end, a newline, &&, ; or ||. A single & or | runs the cd in a subshell,
// so those commands keep the project workdir.
function entersProject(command, directory) {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*cd\\s+(?:\\./)?${escaped}/?(?=[ \\t]*(?:$|\\n|&&|;|\\|\\|))`).test(command);
}
function safeDirectory(directory, create = false) {
  if (create) { try { fs.mkdirSync(directory, {mode:0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe project directory');
  return directory;
}
function safeRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) throw new Error('Workspace unavailable');
  // The configured root itself is trusted and can use a platform alias such
  // as macOS /var -> /private/var. No links below that canonical root are used.
  return safeDirectory(fs.realpathSync(path.resolve(root)));
}
function statePath(root, session, create = false) {
  return path.join(safeDirectory(path.join(safeRoot(root), STATE_DIRECTORY), create), `${session}.json`);
}
function readBinding(root, session) {
  let file;
  try { file = statePath(root,session); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let descriptor;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_STATE_BYTES) throw new Error('Unsafe project registry');
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (stat.ino !== opened.ino || stat.dev !== opened.dev) throw new Error('Changed project registry');
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > MAX_STATE_BYTES) throw new Error('Project registry too large');
    const data = JSON.parse(bytes.subarray(0,length).toString('utf8'));
    if (data.schemaVersion === 1 && data.disabled === true && Object.keys(data).length === 2) return null;
    if (data.schemaVersion !== 1 || !validBinding(data)) throw new Error('Invalid project binding');
    return {source:data.source,directory:data.directory};
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function validBinding(value) {
  const segments = parts(value?.directory);
  return segments?.length === 2 && segments[0] === 'Playground' && !GENERIC.test(segments[1])
    && parts(value?.source)?.length === 1 && !GENERIC.test(value.source);
}
function saveBinding(root, session, binding) {
  readBinding(root,session);
  const file = statePath(root,session,true);
  const records = fs.readdirSync(path.dirname(file));
  if (!records.includes(path.basename(file)) && records.length >= LIMIT) throw new Error('Project registry capacity reached');
  const temporary = path.join(path.dirname(file), `.sessions-${randomBytes(12).toString('hex')}.tmp`);
  try {
    // Separate session records avoid lost updates between concurrent workers.
    fs.writeFileSync(temporary, JSON.stringify({schemaVersion:1,...binding}), {flag:'wx',mode:0o600});
    // Refresh the no-link check before the atomic replacement. Only this
    // bounded routing metadata is replaced; project files are never moved.
    statePath(root,session);
    try { const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe project registry'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function validateProject(root, binding) {
  const base = safeDirectory(path.join(safeRoot(root),'Playground'));
  safeDirectory(path.join(base,binding.directory.split('/')[1]));
}
function reserveProject(root, source) {
  const base = safeDirectory(path.join(safeRoot(root),'Playground'),true);
  for (let i = 1; i <= 1000; i++) {
    const name = i === 1 ? source : `${source.slice(0,58)}-${i}`;
    try { fs.mkdirSync(path.join(base,name),{mode:0o700}); return {source,directory:`Playground/${name}`}; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Choose a different project name');
}
function selectTool(tool, params) {
  if (tool !== 'tool_call') return {tool, args:params, wrap:args=>args};
  const id = params?.id;
  if (typeof id !== 'string' || !/^(?:(?:openclaw:core:)?(?:read|write|edit|apply_patch|exec)|(?:openclaw:pixel-ods:)?pixel_ods_workspace_preview)$/.test(id)) return null;
  return {tool:id.split(':').at(-1),args:params.args,wrap:args=>({...params,args})};
}

// Only simple inspection commands may use an inferred parent cwd or inspect
// a failed routing state. Do not accept shell expressions, executable search
// options (such as rg --pre), or arbitrary programs that can mutate files.
function simpleInspection(selected) {
  if (selected.tool !== 'exec' || typeof selected.args.command !== 'string') return false;
  const command = selected.args.command.trim();
  return /^[A-Za-z0-9_./:\\+ =-]+$/.test(command)
    && /^(?:pwd|ls|dir|Get-ChildItem|Get-Location)(?:\s|$)/i.test(command);
}

// State is per run. Persistent records contain only hashed session identities
// and safe relative paths, never prompts, credentials, or creative bytes.
export function routePlaygroundTool({state,tool,params,root,session,intent,existingPaths=[],preserveExisting=false,continueProject=false}) {
  const selected = selectTool(tool,params);
  if (!selected || !['read','write','edit','apply_patch','exec','pixel_ods_workspace_preview'].includes(selected.tool)
    || !selected.args || typeof root !== 'string' || !path.isAbsolute(root)
    || typeof session !== 'string' || !session || session.length > 2048) return undefined;
  try {
    if (state.failed) throw new Error('Project routing requires recovery');
    const identity = createHash('sha256').update(session).digest('hex');
    const preserve = () => {
      if (!state.preserved && readBinding(root,identity)) saveBinding(root,identity,{disabled:true});
      state.preserved = true;
      state.fresh = false;
      state.binding = null;
    };
    if (preserveExisting || ownerNamesPath(intent)) {
      if (preserveExisting || ['write','edit','apply_patch','pixel_ods_workspace_preview'].includes(selected.tool)) preserve();
      return undefined;
    }
    if (state.preserved) return undefined;
    if (!state.initialized) {
      state.fresh = !continueProject && requestsNewPlaygroundProject(intent);
      state.binding = state.fresh ? null : readBinding(root,identity);
      state.initialized = true;
    }
    const args = selected.args;
    const key = selected.tool === 'exec' ? 'workdir' : selected.tool === 'pixel_ods_workspace_preview' ? 'relativeDirectory' : 'path';
    const target = relative(args[key],root);
    if (!state.binding && state.fresh && ['exec','apply_patch'].includes(selected.tool)) {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      const inspection = selected.tool === 'exec' && !/[;&|><`\r\n]|\$\(/.test(command)
        && /^(?:(?:pwd|ls|dir|rg|Get-ChildItem|Get-Location)(?:\s|$)|(?:node|python3?|npm|git)\s+(?:--version|-v)$|git\s+status(?:\s|$))/i.test(command);
      if (!inspection) {
        // A folder suggested earlier in this run wins over one the command names.
        let next = earlierFolder(state,root) ? state.suggestedPath ?? `Playground/${state.suggestedFolder}/<file name>` : null;
        const named = !next && selected.tool === 'exec' ? commandProjectFolder(command,root) : null;
        if (named) {
          next = `Playground/${named}/<file name>`;
          state.suggestedFolder = named;
          state.suggestedPath = undefined;
        }
        return {block:true,blockReason:`${NOT_RUN}${next ? ` Call write now with path ${next} and its content.` : ''} Create the first project file with write in a descriptive Playground folder before running commands or patches. ${CORRECTION}`};
      }
    }
    if (!state.binding && state.fresh && selected.tool === 'write') {
      // Refusals stay charged failures; only their text names the next path.
      const refuse = () => {
        const suggestion = suggestedProjectPath(args[key],root,state);
        if (suggestion) {
          state.suggestedFolder = suggestion.split('/')[1];
          state.suggestedPath = suggestion;
        }
        return {block:true,blockReason:suggestion
          ? `Not written: project files go in a descriptive Playground folder. Call write again now with path ${suggestion} and the same content, then use that folder for every project file and as exec workdir. ${CORRECTION}`
          : CORRECTION};
      };
      if (!target) return refuse();
      if (existingPaths.includes(target)) { preserve(); return undefined; }
      const segments = parts(target);
      const candidate = segments[0] === 'Playground' ? segments[1] : segments[0];
      if (segments.length < (segments[0] === 'Playground' ? 3 : 2) || !candidate || GENERIC.test(candidate)) return refuse();
      // Legacy projects that the owner is working in stay exactly where they
      // are. Never silently relocate an existing path or overwrite it as new.
      if (segments[0] !== 'Playground') {
        try { fs.lstatSync(path.join(safeRoot(root),segments[0])); preserve(); return undefined; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const binding = reserveProject(root,candidate);
      saveBinding(root,identity,binding);
      state.binding = binding;
    }
    if (!state.binding) return undefined;
    validateProject(root,state.binding);
    const {source,directory} = state.binding;
    const projectPath = (value, mutation = false) => {
      if (value === directory || value?.startsWith(`${directory}/`)) return value;
      if (value === `Playground/${source}` || value?.startsWith(`Playground/${source}/`)) return directory + value.slice(`Playground/${source}`.length);
      if (value === source || value?.startsWith(`${source}/`)) return directory + value.slice(source.length);
      if (value && !value.startsWith('Playground/') && (mutation || !value.includes('/') || LOCAL_FOLDERS.test(value.split('/')[0]))) return `${directory}/${value}`;
      return undefined;
    };
    if (selected.tool === 'apply_patch') {
      if (typeof args.input !== 'string') return {block:true,blockReason:`Use apply_patch input with file paths inside ${directory}.`};
      let count = 0, invalid = false;
      const input = args.input.replace(/^(\*\*\* (?:(?:Add|Update|Delete) File|Move to): )([^\r\n]+)$/gm,(_line,prefix,value)=>{
        count++;
        const mapped = projectPath(relative(value,root),true);
        if (!mapped) {invalid=true;return _line;}
        return prefix+mapped;
      });
      if (!count || invalid) return {block:true,blockReason:`Use exact safe file paths inside ${directory} for this project patch.`};
      return input === args.input ? undefined : {params:selected.wrap({...args,input})};
    }
    let mapped = projectPath(target,['write','edit'].includes(selected.tool));
    // Keep unrelated reads/edits and explicitly located execs untouched. For
    // an unspecified exec cwd, use the project only when the command does not
    // name its workspace-root prefix or first cd into the project from the
    // workspace root; never rewrite shell program text.
    if (selected.tool === 'exec' && (args.workdir === undefined || args.workdir === '.' || args.workdir === '/workspace')) {
      const command = typeof args.command === 'string' ? args.command : '';
      if (command.includes(`${directory}/`) || command.includes('/workspace/') || entersProject(command,directory)) mapped = null;
      else if (command.includes(`${source}/`)) {
        if (directory !== `Playground/${source}`) return {block:true,blockReason:`This project is in ${directory}. Set exec workdir to ${directory} and use filenames relative to that directory; the old ${source}/ prefix names a different project.`};
        if (!simpleInspection(selected)) return {block:true,blockReason:`This project is in ${directory}. Set exec workdir to /workspace/${directory} and use filenames relative to that directory. An automatic parent directory would make this command ambiguous and could move or modify the project folder itself.`};
        mapped = 'Playground';
      } else mapped = directory;
    }
    // Core sandbox exec resolves a relative cwd against the gateway process,
    // not the mounted owner workspace. This hook runs after generic argument
    // normalization, so preserve the sandbox alias when injecting a project.
    // Native execution translates the same alias to its configured workspace.
    if (selected.tool === 'exec' && mapped) mapped = `/workspace/${mapped}`;
    if (!mapped || mapped === args[key]) return undefined;
    if (selected.tool === 'read' && target?.includes('/') && !target.startsWith(`${source}/`) && !target.startsWith('Playground/')) {
      try { fs.lstatSync(path.join(root,...target.split('/'))); return undefined; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return {params:selected.wrap({...args,[key]:mapped})};
  } catch {
    state.failed = true;
    if (simpleInspection(selected)) {
      try {
        safeRoot(root);
        const workdir = selected.args.workdir;
        return {params:selected.wrap({...selected.args,workdir:workdir === undefined || workdir === '.' ? '/workspace' : workdir})};
      } catch { /* An unavailable workspace cannot support safe inspection. */ }
    }
    return {block:true,blockReason:'The project folder could not be safely prepared or restored. Preserve existing files. Inspect the workspace with pwd or ls and check the project metadata before retrying; do not bypass this by writing elsewhere.'};
  }
}
