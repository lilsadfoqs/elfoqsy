# Which AWS read operations return environment variables (a map of names to values, or a list of name/value pairs), from
# the service models the AWS CLI itself ships. These are the reads the proxy hides values in (permissions/hide.ts; the
# HIDE_ENVIRONMENT table in aws.ts), and the ones it could. Run it again when the AWS CLI is updated:
#   python3 -I apps/daemon/test/tools/awsEnvironmentReads.py [DATA_DIR]
# DATA_DIR defaults to the installed CLI's botocore data. The output is a list to read, not a verdict; the report
# (docs/reports/v1.5-report.md) says which of them the filter hides today and which need a key added to hide.ts first.
import json, os, re, sys, glob

DATA = sys.argv[1] if len(sys.argv) > 1 else (glob.glob('/usr/local/aws-cli/v2/*/dist/awscli/botocore/data') or [''])[0]
# The classifier's own idea of a read (apps/daemon/src/permissions/aws.ts READ_OP).
READ_OP = re.compile(r'^(describe-|list-|get-|batch-get-|lookup-|search-|filter-log-events$|start-query$|head-|wait$)')
ENVKEY = re.compile(r'^(env|environment|environmentVariables?|variables|runtimeEnvironment(Variables|Secrets)|defaultArguments|parameters?|tokenUrlParametersMap)$', re.I)


def kebab(op):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', op)
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1-\2', s)
    return s.lower()


def valuebearing(shapes, name):
    """A member shape that is a map of strings, or a list of structures with name+value members."""
    s = shapes.get(name, {})
    t = s.get('type')
    if t == 'map':
        return 'map'
    if t == 'list':
        m = shapes.get(s['member']['shape'], {})
        if m.get('type') == 'structure':
            keys = {k.lower() for k in m.get('members', {})}
            if 'name' in keys and 'value' in keys:
                return 'name/value list'
            if 'key' in keys and 'value' in keys:
                return 'key/value list'
    return None


def walk(shapes, name, path, seen, out, depth=0):
    if depth > 8 or name in seen:
        return
    s = shapes.get(name)
    if not s:
        return
    seen = seen | {name}
    if s.get('type') == 'structure':
        for member, ref in s.get('members', {}).items():
            vb = valuebearing(shapes, ref['shape'])
            if ENVKEY.match(member) and vb and re.search(r'env|variable|runtime|argument', member, re.I):
                out.append((member, vb, '.'.join(path + [member])))
            walk(shapes, ref['shape'], path + [member], seen, out, depth + 1)
    elif s.get('type') == 'list':
        walk(shapes, s['member']['shape'], path + ['[]'], seen, out, depth + 1)
    elif s.get('type') == 'map':
        walk(shapes, s['value']['shape'], path + ['{}'], seen, out, depth + 1)


rows = {}
for svc in sorted(os.listdir(DATA)):
    vs = sorted(glob.glob(os.path.join(DATA, svc, '*', 'service-2.json')))
    if not vs:
        continue
    m = json.load(open(vs[-1]))
    shapes = m.get('shapes', {})
    for op, spec in m.get('operations', {}).items():
        cli = kebab(op)
        if not READ_OP.match(cli) or not spec.get('output'):
            continue
        found = []
        walk(shapes, spec['output']['shape'], [], frozenset(), found)
        if found:
            rows.setdefault(svc, []).append((cli, sorted({(k, vb) for k, vb, _ in found})))
for svc, ops in rows.items():
    print(f'{svc}: ' + '; '.join(f"{cli} [{', '.join(f'{k} ({vb})' for k, vb in kinds)}]" for cli, kinds in ops))
print(f'{sum(len(o) for o in rows.values())} operations in {len(rows)} services')
