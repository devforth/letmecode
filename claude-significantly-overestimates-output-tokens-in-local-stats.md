# Claude Code local /usage significantly overestimate output tokens

Observed in **Claude Code 2.1.195** on Linux (latest `claude` CLI I had on **June 28, 2026**).

We ran into this while building [LetMeCode](https://github.com/devforth/letmecode), a CLI tool we're developing at devforth to measure real inference-API-equivalent $ value across different coding agents.

At first I suspected that LetMeCode was deduplicating too aggressively, and that Claude's own stats were the real ground truth.

So I tried to falsify my own tool first.

After going through real `~/.claude/projects/*.jsonl` transcripts and then capturing live Claude traffic over HTTPS, I landed in the opposite place:

> Claude Code's local stats appear to **significantly overestimate output tokens** by summing repeated cumulative usage snapshots from local transcript rows.

This post is about **Claude Code local stats** and `~/.claude/stats-cache.json`.


## TL;DR

For `Opus 4.8`, Claude's CLI local stats (`/usage` command) showed:

- `In: 661.1k`
- `Out: 5.1m`

[LetMeCode](https://github.com/devforth/letmecode), after deduplicating repeated rows, showed about:

- `Input: 263K`
- `Output: 1.88M`

The suspicious part was the massive output gap: **5.1M vs 1.88M**.

The investigation found:

1. If you simply sum raw `output_tokens` from local transcript rows, you get **exactly** Claude's local `stats-cache.json` number.
2. Those local transcript rows contain huge groups of **exact duplicate usage snapshots** with the same `requestId`, same `message.id`, same token counts.
3. A real tool-using Claude run, captured over HTTP, produces **new request IDs for new model calls**.
4. A single real API response streams **cumulative usage** (`message_start`, then `message_delta`) rather than separate billable outputs.

So the simple story is: Claude's local counter matches raw transcript rows, but raw transcript rows are not the same thing as distinct model generations.

Taken together, that is hard to square with "5.1M output tokens were all real generated output."

## The first red flag

Claude's local stats cache says this for Opus 4.8:

```json
"claude-opus-4-8": {
  "inputTokens": 661098,
  "outputTokens": 5105724,
  "cacheReadInputTokens": 665239304,
  "cacheCreationInputTokens": 25503472,
  "webSearchRequests": 0,
  "costUSD": 0
}
```

That came from:

```bash
sed -n '136,148p' ~/.claude/stats-cache.json
```

Now look at this raw sum over local transcripts, excluding `subagents/workflows`:

```bash
python - <<'PY'
import json
from pathlib import Path

base = Path.home() / ".claude/projects"
output_sum = 0
input_sum = 0
count = 0

for path in base.rglob("*.jsonl"):
    if "subagents/workflows" in str(path):
        continue
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        msg = row.get("message") or {}
        usage = msg.get("usage") or {}
        if msg.get("model") == "claude-opus-4-8":
            output_sum += usage.get("output_tokens", 0) or 0
            input_sum += usage.get("input_tokens", 0) or 0
            count += 1

print({"rows": count, "input_tokens": input_sum, "output_tokens": output_sum})
PY
```

Output:

```python
{'rows': 3663, 'input_tokens': 661098, 'output_tokens': 5105724}
```

So Claude's local stats are not doing something mysterious or server-authoritative here.

They are just matching a raw local transcript sum.

And that raw local transcript sum is exactly where the trouble starts.

## The smoking gun: exact duplicate usage rows

Here is a real duplicate group from one Opus transcript:

```bash
python - <<'PY'
import json
from pathlib import Path
from collections import defaultdict

path = Path(
    "~/.claude/projects/-home-ivan-code-devforth-portal/"
    "42213d22-0d82-4947-837c-904d7564c8f8.jsonl"
).expanduser()

groups = defaultdict(list)
for idx, line in enumerate(path.read_text().splitlines(), start=1):
    if not line.strip():
        continue
    row = json.loads(line)
    msg = row.get("message") or {}
    if msg.get("model") != "claude-opus-4-8":
        continue
    usage = msg.get("usage") or {}
    key = (
        row.get("requestId"),
        msg.get("id"),
        usage.get("input_tokens"),
        usage.get("cache_read_input_tokens"),
        usage.get("cache_creation_input_tokens"),
        usage.get("output_tokens"),
    )
    groups[key].append((idx, row))

items = [(k, v) for k, v in groups.items() if len(v) >= 10]
items.sort(key=lambda kv: len(kv[1]), reverse=True)
key, rows = items[0]

print("count", len(rows))
print("key", key)
for idx, row in rows[:10]:
    kinds = [block.get("type") for block in (row.get("message") or {}).get("content", [])]
    print(idx, row.get("timestamp"), kinds)
PY
```

Output:

```text
count 22
key ('req_011CcCxfQ8WYjyurTAc1wN3z', 'msg_01QeJVW4jBZephe2HTctHVRb', 2, 84236, 1395, 6889)
67 2026-06-19T16:48:50.556Z ['thinking']
68 2026-06-19T16:48:51.034Z ['text']
69 2026-06-19T16:48:53.199Z ['tool_use']
70 2026-06-19T16:48:54.862Z ['tool_use']
71 2026-06-19T16:48:56.741Z ['tool_use']
75 2026-06-19T16:49:03.290Z ['tool_use']
76 2026-06-19T16:49:03.621Z ['tool_use']
77 2026-06-19T16:49:03.785Z ['tool_use']
78 2026-06-19T16:49:04.964Z ['tool_use']
81 2026-06-19T16:49:06.919Z ['tool_use']
```

Same `requestId`.

Same `message.id`.

Same exact usage:

- `input_tokens = 2`
- `cache_read_input_tokens = 84236`
- `cache_creation_input_tokens = 1395`
- `output_tokens = 6889`

In other words, all 22 rows claim to describe the same request and the same assistant message.

Repeated **22 times** across `thinking`, `text`, and many `tool_use` rows.

If you raw-sum those rows, you get:

```text
6889 * 22 = 151,558 output tokens
```

That does not look like "22 separate model generations."

That looks like one cumulative usage snapshot getting copied into multiple transcript rows.

## And it was not just one weird example

When I counted exact duplicate Opus groups in local transcripts, I got:

```bash
python - <<'PY'
import json
from pathlib import Path
from collections import defaultdict

base = Path.home() / ".claude/projects"
groups = defaultdict(list)

for path in base.rglob("*.jsonl"):
    if "subagents/workflows" in str(path):
        continue
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        msg = row.get("message") or {}
        usage = msg.get("usage") or {}
        if msg.get("model") != "claude-opus-4-8":
            continue
        req = row.get("requestId")
        mid = msg.get("id")
        if not req or not mid or not usage:
            continue
        sig = (
            req,
            mid,
            usage.get("input_tokens"),
            usage.get("cache_read_input_tokens"),
            usage.get("cache_creation_input_tokens"),
            usage.get("output_tokens"),
        )
        groups[sig].append(row)

identical_groups = 0
identical_events = 0
identical_delta = 0
for sig, rows in groups.items():
    if len(rows) < 2:
        continue
    identical_groups += 1
    identical_events += len(rows)
    identical_delta += sig[5] * (len(rows) - 1)

print({
    "identical_groups": identical_groups,
    "identical_events": identical_events,
    "identical_output_delta": identical_delta,
})
PY
```

Output:

```python
{
  'identical_groups': 1045,
  'identical_events': 3042,
  'identical_output_delta': 3300770
}
```

That means **3.30 million Opus output tokens** disappear if you remove only exact duplicate same-request same-message same-usage repeats.

No fuzzy heuristics. No clever inference. Just exact duplicates.

## "But maybe one request ID can still hide many real API calls?"

That was the strongest counterargument, and if it were true, the duplicate rows might still be legitimate.

Maybe the agent makes multiple billable model calls during one logical turn, and Claude reuses the same `requestId` or `message.id`.

So I stopped guessing and looked at the real traffic.

## Methodology: how I captured Claude Code's HTTPS traffic

The goal was simple: find out whether one logical tool-using turn maps to one real `/v1/messages` call or many, and whether new real model calls get new request IDs.

Plain Wireshark is not enough here because Claude talks to Anthropic over TLS.

So instead of passively sniffing encrypted packets, I ran Claude through a **trusted MITM proxy**:

1. Run `mitmdump` in Docker.
2. Let it generate its own CA certificate.
3. Tell Claude to trust that CA via `NODE_EXTRA_CA_CERTS`.
4. Force Claude through the proxy using `HTTPS_PROXY` and `CLAUDE_CODE_HTTPS_PROXY`.

The minimal Docker setup looked like this:

```yaml
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:11.0.2
    command:
      - mitmdump
      - --listen-host
      - 0.0.0.0
      - --listen-port
      - "8080"
      - --set
      - anticomp=true
      - --set
      - flow_detail=2
      - -s
      - /scripts/anthropic_logger.py
    ports:
      - "8080:8080"
    volumes:
      - ./mitm:/scripts:ro
      - ./logs:/logs
      - ./state:/home/mitmproxy/.mitmproxy
```

And the wrapper for Claude was basically:

```bash
export HTTP_PROXY="http://127.0.0.1:8080"
export HTTPS_PROXY="http://127.0.0.1:8080"
export CLAUDE_CODE_HTTP_PROXY="http://127.0.0.1:8080"
export CLAUDE_CODE_HTTPS_PROXY="http://127.0.0.1:8080"
export NODE_EXTRA_CA_CERTS="./state/mitmproxy-ca-cert.pem"

claude --debug-file ./logs/claude-debug.log "$@"
```

The custom logger did three useful things:

1. Saved raw request and response bodies for `api.anthropic.com`.
2. Redacted sensitive headers like `Authorization` and cookies.
3. Parsed SSE streams and extracted `usage` snapshots from `message_start` and `message_delta`.

That setup lives in a dedicated repo:

- [devforth/claude-proxy-mitm](https://github.com/devforth/claude-proxy-mitm)
- [docker-compose.yml](https://github.com/devforth/claude-proxy-mitm/blob/main/docker-compose.yml)
- [mitm/anthropic_logger.py](https://github.com/devforth/claude-proxy-mitm/blob/main/mitm/anthropic_logger.py)
- [run_claude_via_proxy.sh](https://github.com/devforth/claude-proxy-mitm/blob/main/run_claude_via_proxy.sh)
- [summarize_flows.py](https://github.com/devforth/claude-proxy-mitm/blob/main/summarize_flows.py)

To reproduce:

```bash
git clone https://github.com/devforth/claude-proxy-mitm.git
cd claude-proxy-mitm
docker compose up -d

./run_claude_via_proxy.sh \
  --model sonnet \
  --permission-mode bypassPermissions \
  --allowedTools "Bash,Read" \
  -p --output-format json \
  "In your first assistant message, emit exactly two tool calls and no prose before them. The calls are independent and should be issued before seeing either result. Tool call 1: Bash command 'pwd'. Tool call 2: Read file 'package.json'. After both results return, reply with exactly two sections: PWD and PACKAGE_NAME."

./summarize_flows.py
```

## The minimal prompt I used

With the plumbing in place, I wanted the smallest possible example that still made Claude behave like an agent, not a plain chatbot.

So I used this prompt:

```text
In your first assistant message, emit exactly two tool calls and no prose before them.
The calls are independent and should be issued before seeing either result.
Tool call 1: Bash command 'pwd'.
Tool call 2: Read file 'package.json'.
After both results return, reply with exactly two sections: PWD and PACKAGE_NAME.
```

And it gave me a very clean trace:

- one hidden Haiku title request
- one Sonnet request that emitted **two tool calls in the same assistant response**
- one Sonnet request that produced the final answer after both tool results came back

## What the real `/v1/messages` calls looked like

In this minimal run there were three server calls total.

### Request 1: hidden Haiku title request

Claude quietly made a title-generation request first:

```json
{
  "model": "claude-haiku-4-5-20251001",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "<session>\nIn your first assistant message, emit exactl ... PWD and PACKAGE_NAME.\n</session>\n\nWrite the title in the language the user wrote in, regardless of the language of the examples above."
        }
      ]
    }
  ]
}
```

So yes: this request really did contain a title-generation instruction. This side request is not the main bug here; it just shows up as its own separate real model call.

You can see the same thing from two other angles too:

- Claude's debug log marked the request source as `generate_session_title`
- the local transcript later stored an `ai-title` row:

```json
{
  "type": "ai-title",
  "aiTitle": "Execute bash command and read package.json",
  "sessionId": "a4a5d1c5-9b4f-4ab6-96ad-29e5df6ac2a8"
}
```

### Request 2: first Sonnet inference request

The first real Sonnet request was just the user prompt:

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "In your first assistant message, emit exactly two tool calls and no prose before them. The calls are independent and should be issued before seeing either result. Tool call 1: Bash command 'pwd'. Tool call 2: Read file 'package.json'. After both results return, reply with exactly two sections: PWD and PACKAGE_NAME."
        }
      ]
    }
  ]
}
```

### Request 3: second Sonnet inference request

This is the key shape to notice.

After the first Sonnet response emitted two tool calls, the **next** Sonnet request body already contained both tool uses and both tool results:

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "In your first assistant message, emit exactly two tool calls and no prose before them. The calls are independent and should be issued before seeing either result. Tool call 1: Bash command 'pwd'. Tool call 2: Read file 'package.json'. After both results return, reply with exactly two sections: PWD and PACKAGE_NAME."
        }
      ]
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_01Wz7TaaD29ieCcCKbZdrkuN",
          "name": "Bash",
          "input": {
            "command": "pwd"
          }
        },
        {
          "type": "tool_use",
          "id": "toolu_018C9qTeyftnz8JL6WeHbY5M",
          "name": "Read",
          "input": {
            "file_path": "/home/ivan/code/letmecode/package.json"
          }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_018C9qTeyftnz8JL6WeHbY5M",
          "content": "1\t{\n2\t  \"name\": \"letmecode\",\n3\t  \"version\": \"0.1.15\",\n..."
        },
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01Wz7TaaD29ieCcCKbZdrkuN",
          "content": "/home/ivan/code/letmecode",
          "is_error": false
        }
      ]
    }
  ]
}
```

Even this one request body gives away a lot:

- the tool loop is not some opaque client-side magic
- Claude really does build a larger follow-up prompt and send it back to `/v1/messages`
- multiple tools can appear in the same assistant turn and then in the same follow-up prompt

## What the real `/v1/messages` responses looked like

### Response 1: hidden Haiku title request

```text
event: message_start
data: {"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","id":"msg_01LnaNa3Dwz1LzciyYE6feyx","usage":{"input_tokens":574,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\"title\": \"Execute"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" bash command and read package.json\"}"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":574,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":16}}
```

The actual emitted text payload here was:

```text
{"title": "Execute bash command and read package.json"}
```

What showed up in local `jsonl` right after that was not a normal assistant turn, but an `ai-title` metadata row:

```json
{
  "type": "ai-title",
  "aiTitle": "Execute bash command and read package.json",
  "sessionId": "a4a5d1c5-9b4f-4ab6-96ad-29e5df6ac2a8"
}
```

So the client clearly records the generated title, but in local `jsonl` I do **not** see a normal assistant row with `message.usage` for this Haiku request. It is represented as title metadata, not as an ordinary transcript event.

### Response 2: first Sonnet response with two tool calls

This is the response that made the whole mismatch click for me.

One single HTTP response stream emitted **two tool calls**:

```text
event: message_start
data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","id":"msg_01Bfx5QqsejiNrgQdATW146i","usage":{"input_tokens":3,"cache_creation_input_tokens":6430,"cache_read_input_tokens":16294,"output_tokens":5}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01Wz7TaaD29ieCcCKbZdrkuN","name":"Bash","input":{},"caller":{"type":"direct"}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\": \"pwd"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"}"}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_018C9qTeyftnz8JL6WeHbY5M","name":"Read","input":{},"caller":{"type":"direct"}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\": \"/home/ivan/code/letmecode/package.json"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"}"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":3,"cache_creation_input_tokens":6430,"cache_read_input_tokens":16294,"output_tokens":101}}
```

There was no natural-language prose in this response at all. The actual emitted payload was just the two tool JSON inputs:

```text
{"command": "pwd"}
{"file_path": "/home/ivan/code/letmecode/package.json"}
```

The important part is not the tiny visible JSON. The important part is that this was one HTTP response, but the local transcript split it into multiple rows that all carry the same final `usage`.

And this is exactly how that one real HTTP response got split in local `jsonl`:

```json
{
  "line": 8,
  "requestId": "req_011CcVdNNYdvWsgt9vHPSKau",
  "message.id": "msg_01Bfx5QqsejiNrgQdATW146i",
  "stop_reason": "tool_use",
  "content": [{"type":"tool_use","name":"Bash","input":{"command":"pwd"}}],
  "usage": {"input_tokens":3,"cache_read_input_tokens":16294,"cache_creation_input_tokens":6430,"output_tokens":101}
}
```

```json
{
  "line": 9,
  "requestId": "req_011CcVdNNYdvWsgt9vHPSKau",
  "message.id": "msg_01Bfx5QqsejiNrgQdATW146i",
  "stop_reason": "tool_use",
  "content": [{"type":"tool_use","name":"Read","input":{"file_path":"/home/ivan/code/letmecode/package.json"}}],
  "usage": {"input_tokens":3,"cache_read_input_tokens":16294,"cache_creation_input_tokens":6430,"output_tokens":101}
}
```

This is the part that matters:

- same `requestId`
- same `message.id`
- same `usage`
- but two separate local rows, because one real assistant response contained two tool blocks

### Response 3: final Sonnet response after both tool results

```text
event: message_start
data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","id":"msg_018zETUn8jwfxEpqQMMn4FXs","usage":{"input_tokens":642,"cache_creation_input_tokens":144,"cache_read_input_tokens":22724,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"**"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PWD**\n/home/ivan/code/letmecode\n\n**PACKAGE_NAME**\nletmecode"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":642,"cache_creation_input_tokens":144,"cache_read_input_tokens":22724,"output_tokens":29}}
```

The actual final emitted text was:

```text
**PWD**
/home/ivan/code/letmecode

**PACKAGE_NAME**
letmecode
```

And this is what the local transcript stored around that second Sonnet request:

```json
{
  "line": 10,
  "type": "user",
  "content": [{"tool_use_id":"toolu_018C9qTeyftnz8JL6WeHbY5M","type":"tool_result","content":"1\t{ ... package.json ... }"}]
}
```

```json
{
  "line": 11,
  "type": "user",
  "content": [{"tool_use_id":"toolu_01Wz7TaaD29ieCcCKbZdrkuN","type":"tool_result","content":"/home/ivan/code/letmecode"}]
}
```

```json
{
  "line": 12,
  "requestId": "req_011CcVdNZHoNHLJAGw3ubMqS",
  "message.id": "msg_018zETUn8jwfxEpqQMMn4FXs",
  "stop_reason": "end_turn",
  "content": [{"type":"text","text":"**PWD**\n/home/ivan/code/letmecode\n\n**PACKAGE_NAME**\nletmecode"}],
  "usage": {"input_tokens":642,"cache_read_input_tokens":22724,"cache_creation_input_tokens":144,"output_tokens":29}
}
```

At this point, three details matter:

1. The first Sonnet response emits **two `content_block_start` tool_use blocks** before it stops.
2. The local transcript stores those tool blocks as separate rows, but copies the same final `usage` onto both of them.
3. The final answer arrives under a **different `requestId`**, which is exactly what you would expect from a new real model call.

## The debug log showed the two tools were really dispatched together

Claude's own debug log around the first Sonnet response looked like this:

```text
2026-06-28T12:05:37.177Z [INFO] [Stall] tool_dispatch_start tool=Bash toolUseId=toolu_01Wz7TaaD29ieCcCKbZdrkuN
2026-06-28T12:05:37.208Z [INFO] [Stall] tool_dispatch_start tool=Read toolUseId=toolu_018C9qTeyftnz8JL6WeHbY5M
2026-06-28T12:05:37.224Z [INFO] [Stall] tool_dispatch_end tool=Read toolUseId=toolu_018C9qTeyftnz8JL6WeHbY5M
2026-06-28T12:05:37.301Z [INFO] [Stall] tool_dispatch_end tool=Bash toolUseId=toolu_01Wz7TaaD29ieCcCKbZdrkuN
```

So this was not "Claude called Bash, waited, then later decided to call Read."

It emitted both tool calls first, and then both tools were dispatched from that same assistant turn.

One useful takeaway here: the visible `input_json_delta` fragments are **not** the whole output being counted inside that `101`. The [Anthropic streaming docs](https://platform.claude.com/docs/en/build-with-claude/streaming) show that those deltas only update the `tool_use.input` field. The final `message_delta.usage` belongs to the whole assistant turn, including hidden tool-use structure and overhead, not just the tiny JSON fragments you can see on screen. So you should read `101` as "the total output for that assistant turn," not as "the size of the visible JSON." In repeated captures, this did **not** look like thinking overhead.

## What the proxy summary showed

The proxy summary for this experiment was:

```text
Request paths:
   3  /v1/messages?beta=true

Traces:
- ... POST /v1/messages?beta=true model=claude-haiku-4-5-20251001
  usage[message_start] in=574 out=5 cache_read=0 cache_create=0
  usage[message_delta] in=574 out=16 cache_read=0 cache_create=0

- ... POST /v1/messages?beta=true model=claude-sonnet-4-6
  usage[message_start] in=3 out=5 cache_read=16294 cache_create=6430
  usage[message_delta] in=3 out=101 cache_read=16294 cache_create=6430

- ... POST /v1/messages?beta=true model=claude-sonnet-4-6
  usage[message_start] in=642 out=1 cache_read=22724 cache_create=144
  usage[message_delta] in=642 out=29 cache_read=22724 cache_create=144
```

Three things jump out here:

1. Claude sneaks in a hidden **Haiku** call just to generate the session title.
2. The first Sonnet response is one real HTTP request that emits **two tool calls**.
3. The final answer is a separate second Sonnet request after tool results are appended.

The proxy-captured **server request IDs** matched those exact local `requestId` values.

This is the part that matters for the stats mismatch:

- when Claude makes a **new real model call**, I see a **new request ID**
- when Claude emits **multiple tool blocks inside one real model call**, the local transcript may split that one response into multiple rows with the **same** `requestId`, `message.id`, and `usage`

That is exactly the kind of data shape that makes raw local summation overcount.

## One response, one cumulative usage counter

Look again at the live HTTP capture for the first Sonnet response with two tool calls:

```text
usage[message_start] in=3 out=5 cache_read=16294 cache_create=6430
usage[message_delta] in=3 out=101 cache_read=16294 cache_create=6430
```

That is one API response stream. According to the [Anthropic streaming docs](https://docs.anthropic.com/en/api/messages-streaming), the token counts in `message_delta.usage` are cumulative for that stream, and the `input_json_delta` events only describe updates to the `tool_use.input` field.

And the matching local `jsonl` rows did **not** store `105`.

They stored `101`.

In plain English:

- `5` was an early usage snapshot
- `101` was a later usage snapshot for the same request
- the per-request final output for that response is `101`, not `5 + 101`

It is the same counter seen at two different moments during the same response.

So if you were using the raw Messages API directly, the number you would use for accounting on that response is the final cumulative `message_delta.usage` value, which here was `101`. If the client later copies that same final `usage` onto multiple local transcript rows, the local raw sum will blow up fast.

## What I think is happening

Here is the reading that best fits all the evidence:

1. Claude's local stats are based on raw local transcript rows.
2. Those transcript rows may repeat the same cumulative `usage` snapshot across multiple row types (`thinking`, `text`, `tool_use`, maybe others).
3. Raw summation therefore inflates output totals, especially for long tool-heavy sessions.
4. Any local-audit tool, including LetMeCode, should not treat every local row as a separate API generation event.

Put bluntly:

> Claude local stats look much closer to "sum of transcript usage rows" than to "sum of real distinct model generations."

## What I am **not** saying

I am **not** claiming:

- Anthropic's server-side billing engine is wrong
- Anthropic invoices necessarily use this same overcounted local method
- every dedup heuristic is automatically correct

What I **am** saying is narrower:

> On Claude Code 2.1.195, the local stats pipeline appears to significantly overestimate output tokens in this real-world dataset.

## How to reproduce the problem yourself

### 1. Compare local stats cache with raw transcript sums

```bash
sed -n '136,148p' ~/.claude/stats-cache.json
```

```bash
python - <<'PY'
import json
from pathlib import Path

base = Path.home() / ".claude/projects"
output_sum = 0

for path in base.rglob("*.jsonl"):
    if "subagents/workflows" in str(path):
        continue
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        msg = row.get("message") or {}
        usage = msg.get("usage") or {}
        if msg.get("model") == "claude-opus-4-8":
            output_sum += usage.get("output_tokens", 0) or 0

print(output_sum)
PY
```

### 2. Hunt for exact duplicate usage groups

```bash
python - <<'PY'
import json
from pathlib import Path
from collections import defaultdict

base = Path.home() / ".claude/projects"
groups = defaultdict(int)

for path in base.rglob("*.jsonl"):
    if "subagents/workflows" in str(path):
        continue
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        msg = row.get("message") or {}
        usage = msg.get("usage") or {}
        key = (
            msg.get("model"),
            row.get("requestId"),
            msg.get("id"),
            usage.get("input_tokens"),
            usage.get("cache_read_input_tokens"),
            usage.get("cache_creation_input_tokens"),
            usage.get("output_tokens"),
        )
        groups[key] += 1

dupes = [(k, c) for k, c in groups.items() if c > 1 and k[0] == "claude-opus-4-8"]
dupes.sort(key=lambda x: x[1], reverse=True)
print(dupes[:10])
PY
```

### 3. Watch real HTTP calls instead of arguing from theory

```bash
git clone https://github.com/devforth/claude-proxy-mitm.git
cd claude-proxy-mitm
docker compose up -d
./run_claude_via_proxy.sh \
  --model sonnet \
  --permission-mode bypassPermissions \
  --allowedTools "Bash,Read" \
  -p --output-format json \
  "In your first assistant message, emit exactly two tool calls and no prose before them. The calls are independent and should be issued before seeing either result. Tool call 1: Bash command 'pwd'. Tool call 2: Read file 'package.json'. After both results return, reply with exactly two sections: PWD and PACKAGE_NAME."
./summarize_flows.py
```

If the "same request ID can hide many real model calls" theory were true in the way needed to explain the giant duplicate groups, this is where it should have shown up.

It did not.

## Final thought

The tricky part is that Claude's local stats look more "official" than a third-party tool, and that makes them easy to trust.

But in this case, the prettier UI was not the more believable source.

What convinced me was the boring stuff:

- local JSONL rows
- exact duplicate usage snapshots
- and real HTTP traces

Once those three lined up, the story got pretty hard to ignore.
