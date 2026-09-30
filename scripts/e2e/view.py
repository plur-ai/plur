import json, sys
for l in open(sys.argv[1]):
    try:
        d = json.loads(l)
    except Exception:
        continue
    t, st = d.get('type'), d.get('subtype')
    if t in ('e2e_turn', 'e2e_note'):
        print('====', json.dumps(d))
    elif st == 'init':
        print('INIT session', d.get('session_id'), 'mcp', d.get('mcp_servers'))
    elif st == 'hook_response':
        out = d.get('output') or ''
        try:
            out = json.loads(out)['hookSpecificOutput'].get('additionalContext', out)
        except Exception:
            pass
        print(f"HOOK {d.get('hook_name')} exit={d.get('exit_code')} {d.get('outcome')}: {str(out)[:1500]}" + (f" STDERR={d.get('stderr')[:300]}" if d.get('stderr') else ''))
    elif t == 'assistant':
        for c in d['message']['content']:
            if c.get('type') == 'text':
                print('ASSISTANT:', c['text'][:1500])
            elif c.get('type') == 'tool_use':
                print('TOOL_USE:', c['name'], json.dumps(c.get('input'))[:600])
    elif t == 'user':
        for c in d.get('message', {}).get('content', []):
            if isinstance(c, dict) and c.get('type') == 'tool_result':
                cc = c.get('content')
                if isinstance(cc, list):
                    cc = ' '.join(x.get('text', '') for x in cc if isinstance(x, dict))
                print('TOOL_RESULT:', str(cc)[:800])
    elif t == 'result':
        print('RESULT:', d.get('is_error'), str(d.get('result'))[:500], 'session', d.get('session_id'))
