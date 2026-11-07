# Which AWS read operations write their answer to a file named in the call: botocore's `has_streaming_output`, an output
# whose payload is a blob, makes the CLI ask for a required positional `outfile` (awscli/customizations/streamingoutputarg.py),
# and the CLI opens it for writing with the caller's access, wherever it is. "Read" is the classifier's own idea of one
# (READ_OP in apps/daemon/src/permissions/aws.ts). The WRITES_FILES table in aws.ts is this list; test/aws-model-coverage.test.ts
# fails when a model has one the table lacks. Run it again when the AWS CLI is updated:
#   python3 -I apps/daemon/test/tools/awsFileWrites.py [DATA_DIR]        # TypeScript table rows, for aws.ts
import json, os, re, sys, glob

DATA = sys.argv[1] if len(sys.argv) > 1 else (glob.glob('/usr/local/aws-cli/v2/*/dist/awscli/botocore/data') or [''])[0]
READ_OP = re.compile(r'^(describe-|list-|get-|batch-get-|lookup-|search-|filter-log-events$|start-query$|get-query-results$|head-|wait$)')


def kebab(op):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', op)
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1-\2', s)
    return s.lower()


# The service's directory in the models is not always its command: botocore's `s3` is the CLI's `s3api`.
COMMAND = {'s3': 's3api'}
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
        out = shapes.get(spec['output']['shape'], {})
        payload = out.get('payload')
        if payload and shapes.get(out.get('members', {}).get(payload, {}).get('shape'), {}).get('type') == 'blob':
            rows.setdefault(COMMAND.get(svc, svc), []).append(cli)
for svc, ops in rows.items():
    print(f"  ['{svc}', /^({'|'.join(sorted(ops))})$/],")
