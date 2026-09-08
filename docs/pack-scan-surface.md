# What the pack scanner looks for

Installing a pack runs a scan first, and a hit of type `secret` refuses the
install with no override (ENGRAM-STANDARD-v1 §5.6.1 step 2). That rule is only
fair if a producer can predict it, so §5.6.1 says a consumer SHOULD document its
scan surface. This is the reference implementation's.

It is a heuristic, not a guarantee. It is written to have few false positives
rather than no false negatives: a pack that passes has not been proven clean, it
has only not matched anything below.

## Where it applies

| Scanned | How |
|---|---|
| `engrams.yaml` | as structured data, field by field |
| every other text file the pack ships | as raw text, including `README.md` and anything else in the archive |

Two things follow from "every other text file". A file the scanner cannot read
is reported rather than skipped, because a skipped file is a place to hide
things. And a file larger than **16 MiB** is not scanned at all — it is reported
as `unscannable` and, except for a `provenance/` record, refuses the install.

Within one file, only the first **1 MiB** is scanned. Past that the scan reports
`scan_truncated` and fails closed, so a payload cannot hide in a long tail.

Every pattern is matched twice: against the raw text, and against a folded copy
with zero-width characters removed and confusable letters normalised. A
zero-width joiner inside a key, or a Cyrillic letter that looks like a Latin
one, does not get a credential past the scan.

## Credentials — these refuse the install

| Name | What matches |
|---|---|
| `aws_access_key` | `AKIA` followed by 16 uppercase letters or digits |
| `aws_secret_key` | `aws_secret_access_key` or `secret_access_key`, then `=` or `:`, then 40 base64 characters |
| `generic_api_key` | `sk` or `pk`, a `-` or `_`, then 20 or more characters — this is the `sk-ant-…` and `sk-…` shape |
| `api_key_assignment` | `api_key`, `api-key`, `api_secret` or `secret_key`, then `=` or `:`, then 20 or more non-space characters |
| `password_assignment` | `password`, then `=` or `:`, then 8 or more non-space characters |
| `connection_string` | a `postgres://`, `mysql://`, `mongodb://` or `redis://` URL |
| `jwt` | two base64url segments each starting `eyJ`, joined by a dot |
| `private_key` | a `-----BEGIN … PRIVATE KEY-----` header |
| `bearer_token` | `Bearer` followed by 20 or more token characters |

## Infrastructure — these also refuse the install

A pack is an archive sent to a stranger, so the scanner treats deployment
topology as sensitive too, not only credentials. These come from a real
incident: the leak that prompted them was addresses and internal host names, and
none of the patterns above matched any of it.

| Name | What matches |
|---|---|
| `basic_auth_url` | `user:pass@host`, with or without a scheme, including the empty-username form |
| `fqdn_port` | a dotted host name with a port, such as `db.example.com:5432` |
| `ipv4_port` | an IPv4 address with a port |
| `public_ipv4` | any IPv4 address that is **not** private, loopback, link-local or documentation-reserved |
| `public_ipv6` | the same stance for globally routable IPv6 |
| `internal_host` | a multi-label host name ending in `.local`, `.internal`, `.corp`, `.lan`, `.intranet`, or Kubernetes `.svc` / `.svc.cluster.local`; or one containing a `staging` label |
| `scan_truncated` | the file was longer than the 1 MiB scan limit, so part of it was never checked |

Two deliberate non-matches, because they produced false positives on real
packs: a standalone word such as `prod`, `db` or `redis`, and an ordinary public
host name such as `example.com` or `api.github.com`. A host-shaped token whose
tail is a known file extension (`config.local`, `data-staging.csv`) is also let
through.

## Prompt injection — reported, and overridable

Instruction-override text is a separate finding of type `prompt_injection`. It
blocks by default but **can** be overridden, because a pack that legitimately
teaches about prompt injection has to be able to contain examples of it.

Matched: `ignore previous …`, `disregard the above …`, `forget everything …`,
`override your instructions`, `reveal the system prompt`, `you are now …` /
`from now on you will …`, `bypass the safety …`, `developer mode` / `DAN mode` /
`jailbreak`, and `<system>` or `[system]` tags.

## If your pack is refused and you believe it is wrong

The remedy is a corrected pack. Change the example so it does not match — most
false positives are a placeholder that looks like a real credential, and giving
it an obviously fake shape fixes it.

If you are the recipient rather than the producer, and the producer cannot be
reached, correcting the pack locally changes its contents and so no longer
matches the integrity value it shipped. Install that with
`plur packs install <dir> --force`, which accepts an integrity mismatch. It does
not, and cannot, override the secret refusal itself, the declared-private
refusal, or a file the scan could not read.

If a pattern here is wrong rather than your example, that is a bug worth filing
against this repository — it affects every producer, not just one pack.
