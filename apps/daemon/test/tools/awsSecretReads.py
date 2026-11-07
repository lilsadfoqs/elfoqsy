# Which AWS read operations return secret values, from the service models the AWS CLI itself ships (botocore's
# service-2.json). "Read" is the classifier's own idea of one (READ_OP in apps/daemon/src/permissions/aws.ts: describe-,
# list-, get-, batch-get-, ...). For each, the output shape is walked for members that AWS marks `sensitive`, or that are
# named like a secret (environment, password, token, userData...). Run it again when the AWS CLI is updated:
#   python3 -I apps/daemon/test/tools/awsSecretReads.py sensitive [DATA_DIR]   # members AWS flags (noisy: emails, comments)
#   python3 -I apps/daemon/test/tools/awsSecretReads.py name [DATA_DIR]        # named like a secret, not flagged
# DATA_DIR defaults to the installed CLI's botocore data. The output is a list to read, not a verdict: the hits are
# values, metadata and noise together, and docs/reports/v1.5-report.md has the ones that matter, checked by hand.
import json, os, re, sys, glob

DATA = sys.argv[2] if len(sys.argv) > 2 else (glob.glob('/usr/local/aws-cli/v2/*/dist/awscli/botocore/data') or [''])[0]
# The classifier's own idea of a read (apps/daemon/src/permissions/aws.ts READ_OP).
READ_OP = re.compile(r'^(describe-|list-|get-|batch-get-|lookup-|search-|filter-log-events$|start-query$|head-|wait$)')
NAME = re.compile(r'(password|passwd|secret|token|credential|privatekey|apikey|api_key|userdata|accesskey|authorization|variables|environment|connectionstring|keyvalue|signingkey|passphrase|sshkey|presigned|location$)', re.I)
SKIP = re.compile(r'(NextToken|PageToken|Marker$|TokenType|Arn$|ARN$|Name$|Id$|Ids$|Type$|Status$|Count$|Length$|Time$|Date$|Version$|Enabled$|Description$|Policy$|Rotation|Expir|LastChanged|LastAccessed|CreatedDate|Credentials?Report|ContinuationToken|NextSecret|SecretString$)', re.I)

def kebab(op):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', op)
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1-\2', s)
    return s.lower()

def walk(shapes, name, path, seen, out, depth=0):
    if depth > 7 or name in seen:
        return
    shape = shapes.get(name)
    if not shape:
        return
    t = shape.get('type')
    seen = seen | {name}
    if t == 'structure':
        for member, ref in shape.get('members', {}).items():
            target = shapes.get(ref['shape'], {})
            sens = bool(ref.get('sensitive') or target.get('sensitive'))
            p = path + [member]
            if sens or (NAME.search(member) and not SKIP.search(member) and target.get('type') in ('string', 'blob', 'map', 'list', 'structure')):
                out.append(('SENSITIVE' if sens else 'name', '.'.join(p)))
            walk(shapes, ref['shape'], p, seen, out, depth + 1)
    elif t == 'list':
        walk(shapes, shape['member']['shape'], path + ['[]'], seen, out, depth + 1)
    elif t == 'map':
        walk(shapes, shape['value']['shape'], path + ['{}'], seen, out, depth + 1)

rows = []
for svc in sorted(os.listdir(DATA)):
    versions = sorted(glob.glob(os.path.join(DATA, svc, '*', 'service-2.json')))
    if not versions:
        continue
    model = json.load(open(versions[-1]))
    shapes = model.get('shapes', {})
    for op, spec in model.get('operations', {}).items():
        cli = kebab(op)
        if not READ_OP.match(cli):
            continue
        out_shape = spec.get('output', {}).get('shape')
        if not out_shape:
            continue
        found = []
        walk(shapes, out_shape, [], frozenset(), found)
        if found:
            rows.append((svc, cli, found))

mode = sys.argv[1] if len(sys.argv) > 1 else 'sensitive'
for svc, cli, found in rows:
    kinds = {k for k, _ in found}
    if mode == 'sensitive' and 'SENSITIVE' not in kinds:
        continue
    picks = [p for k, p in found if (k == 'SENSITIVE') == (mode == 'sensitive')][:4]
    print(f'{svc} {cli}: {", ".join(picks)}')
