import json, sys
sid = sys.argv[1]
j = json.load(open('data/tmp.json'))
rows = [o for o in j.get('observations', []) if o.get('value') not in ('.', '', None)]
if len(rows) >= 3:
    with open('data/fred_%s.csv' % sid, 'w') as f:
        f.write('observation_date,%s\n' % sid)
        for o in rows:
            f.write('%s,%s\n' % (o['date'], o['value']))
    print('saved', sid, len(rows), 'rows, last', rows[-1]['date'])
else:
    print('no usable rows for', sid, str(j)[:150])
