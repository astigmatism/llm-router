"""Bound web evidence sent to the model while keeping omitted content addressable."""
import json
import re

MAX_PAGE_CHARS = 16000


def pointer_token(key):
    return str(key).replace('~', '~0').replace('/', '~1')


def select_pointer(value, pointer):
    if not pointer:
        return value
    if not pointer.startswith('/'):
        raise ValueError('json_pointer must be empty or start with / (RFC 6901)')
    for token in pointer[1:].split('/'):
        token = token.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            if not token.isdecimal():
                raise ValueError('JSON array pointers require a nonnegative index')
            value = value[int(token)]
        elif isinstance(value, dict):
            value = value[token]
        else:
            raise ValueError('JSON pointer traverses a scalar value')
    return value


def preview(value, pointer='', depth=0, string_limit=240, array_limit=3):
    if isinstance(value, str):
        if len(value) <= string_limit:
            return value
        return value[:string_limit] + f' [omitted {len(value)-string_limit} characters; json_pointer={pointer}]'
    if not isinstance(value, (dict, list)):
        return value
    if depth >= 4:
        return {'_json_pointer': pointer, '_omitted': f'{type(value).__name__} with {len(value)} entries'}
    if isinstance(value, dict):
        return {key: preview(child, pointer + '/' + pointer_token(key), depth + 1, string_limit, array_limit)
                for key, child in value.items()}
    # Preserve the first twenty top-level records; compact expensive nested arrays.
    limit = 20 if depth <= 1 else array_limit
    result = [preview(child, pointer + '/' + str(index), depth + 1, string_limit, array_limit)
              for index, child in enumerate(value[:limit])]
    if len(value) > limit:
        result.append({'_omitted_items': len(value) - limit, '_next_json_pointer': pointer + '/' + str(limit)})
    return result


def render_fetch_result(content, url, json_pointer='', start=0, max_chars=None):
    if not isinstance(start, int) or isinstance(start, bool) or start < 0:
        raise ValueError('start must be a nonnegative character offset')
    limit = min(int(max_chars), MAX_PAGE_CHARS) if max_chars and int(max_chars) > 0 else MAX_PAGE_CHARS
    limit = max(1000, limit)
    content = content or ''
    try:
        document = json.loads(content)
    except (ValueError, TypeError):
        document = None
        if json_pointer:
            raise ValueError('json_pointer is available only for JSON responses')
    if json_pointer:
        document = select_pointer(document, json_pointer)
        content = document if isinstance(document, str) else json.dumps(document, ensure_ascii=False)
    if not start and len(content) <= limit:
        return content

    if isinstance(document, (dict, list)) and not start:
        for string_limit, array_limit in [(240, 3), (100, 2), (40, 1)]:
            selected = preview(document, json_pointer, string_limit=string_limit, array_limit=array_limit)
            result = json.dumps({'url': url, 'format': 'json_preview', 'json_pointer': json_pointer,
                'total_characters': len(content), 'content': selected,
                'notice': 'Large JSON response: nested arrays and long strings are abbreviated. '
                          'Request any omitted value with fetch_url(url, json_pointer="/path/to/value"). '
                          'Array entries use numeric indexes. start reads a later character window of a selected value.'},
                ensure_ascii=False)
            if len(result) <= limit:
                return result

    # A text window also provides a fallback for unusually wide JSON structures.
    # Reserve room for an explicit continuation notice; never silently cut evidence.
    if start > len(content):
        raise ValueError(f'start exceeds the selected content length ({len(content)})')
    def window(end):
        return json.dumps({'url': url, 'format': 'text_window', 'json_pointer': json_pointer,
            'start': start, 'end': end, 'total_characters': len(content),
            'content': content[start:end], 'next_start': end if end < len(content) else None,
            'notice': 'Partial source content. Use fetch_url with the same url and json_pointer, '
                      'and start=next_start to read further. Do not assume omitted content is absent.'},
            ensure_ascii=False)
    low, high = start, min(len(content), start + limit)
    while low < high:
        middle = (low + high + 1) // 2
        if len(window(middle)) <= limit:
            low = middle
        else:
            high = middle - 1
    if len(window(low)) > limit or (low == start and start < len(content)):
        raise ValueError('URL or JSON pointer is too long for a content window')
    return window(low)


def lowest_backend_version(responses):
    valid = [r for r in responses if isinstance(r, dict) and isinstance(r.get('version'), str)]
    numeric = []
    for response in valid:
        match = re.match(r'^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$', response['version'])
        if match:
            parts = tuple(map(int, match.group(1).split('.')))
            numeric.append((parts + (0,) * (4 - len(parts)), response['version']))
    if numeric:
        return min(numeric)[1]
    # Compatible backends can truthfully identify themselves as llama.cpp-<revision>.
    # Preserve that identity instead of parsing it as an Ollama semantic version.
    return valid[0]['version'] if valid else False
