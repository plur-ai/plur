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

The credential patterns below are also matched against a percent-decoded copy
(ASCII `%00`–`%7F`, up to three passes), so a token inside an encoded URL or
query string, such as `access_token%3D` followed by the token, is still found.
They are also matched against a copy with JSON backslash escapes unfolded
(`\n`, `\t`, `\r`, `\b`, `\f`, `\\`, `\"`, `\/` and ASCII `\u00XX`, up to three
passes), so a token that follows a literal `\n` in JSON-escaped text or a
pasted log is still found. The infrastructure patterns are not matched against
the decoded or unfolded copies.

## Credentials — these refuse the install

| Name | What matches |
|---|---|
| `aws_access_key` | `AKIA` (long-term) followed by 16 uppercase letters or digits; or `ASIA` (temporary) followed by exactly 16 uppercase letters or digits, at least one a digit, with no letter or digit on either side |
| `github_token` | `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_`, then 36 or more letters or digits |
| `github_pat` | `github_pat_`, 22 or more letters or digits, `_`, then 40 or more letters or digits |
| `gitlab_token` | a documented GitLab prefix (`glpat-`, `gloas-`, `gldt-`, `glrt-`, `glrtr-`, `glcbt-`, `glptt-`, `glft-`, `glimt-`, `glagent-`, `glwt-`, `glsoat-`, `glffct-`), then 20 or more letters, digits, `_` or `-`, where the body has random-token structure: a lowercase letter or digit followed by an uppercase letter, an uppercase letter followed by an uppercase letter or digit, or four digits. A lowercase or Title-Case hyphenated slug after the prefix, as in a docs URL, does not match |
| `slack_token` | `xoxb-`, `xoxp-` or `xoxs-`, a numeric id of 8 or more digits and `-`, then 10 or more token characters; or `xoxa-` / `xoxr-`, an optional digit and `-`, then an unbroken run of 16 or more letters and digits containing both; or an app-level `xapp-<digit>-<app id>-<number>-<secret>`; or a rotation token `xoxe-`, `xoxe.xoxp-` or `xoxe.xoxb-`, a number and `-`, then 100 or more letters and digits |
| `npm_token` | `npm_` followed by 36 or more letters or digits |
| `stripe_live_key` | `sk_live_` or `rk_live_` followed by 24 or more letters or digits |
| `aws_secret_key` | `aws_secret_access_key` or `secret_access_key`, then `=` or `:`, then 40 base64 characters |
| `generic_api_key` | `sk` or `pk`, a `-` or `_`, then 20 or more characters — this is the `sk-ant-…` and `sk-…` shape |
| `api_key_assignment` | `api_key`, `api-key`, `api_secret` or `secret_key`, then `=` or `:`, then 20 or more non-space characters |
| `password_assignment` | `password`, then `=` or `:`, then 8 or more non-space characters |
| `connection_string` | a `postgres://`, `mysql://`, `mongodb://` or `redis://` URL |
| `jwt` | two base64url segments each starting `eyJ`, joined by a dot |
| `private_key` | a `-----BEGIN … PRIVATE KEY-----` header |
| `bearer_token` | `Bearer` followed by 20 or more token characters |

A credential finding names the pattern and shows only the matched value's
prefix (the vendor prefix, the keyword of an assignment, or the URL scheme) and
its last four characters, for example `github_token: ghp_...WXYZ`. A value
shorter than 16 characters after the prefix, such as a password, is not shown.

The vendor-prefixed patterns (`github_token` to `stripe_live_key`) do not match
when the prefix is glued onto the end of a longer word (a preceding digit or
`=` does not count), and each needs the vendor's
documented body length, so text that only names a prefix ("use a `ghp_` token")
does not refuse an install.

### Known limitations of the credential patterns

- **A custom GitLab token prefix is not detected.** A self-managed GitLab
  instance can configure its own personal-access-token prefix in place of
  `glpat-`. `gitlab_token` knows only the documented prefixes, so a token with
  a custom prefix scans clean.
- **A placeholder with a real prefix is flagged.** A documentation placeholder
  such as `glpat-` followed by twenty uppercase `X` characters, or `ghp_` or
  `npm_` followed by 36 of them, has the prefix, length and charset of a real
  token, so a pack whose README uses one is refused. Use a placeholder that is
  visibly not a token, such as `glpat-<your-token>`.
- **A few real legacy GitLab tokens are missed.** The structure check that
  keeps hyphenated slugs out of `gitlab_token` also rejects a random legacy
  20-character body that happens to have no mixed-case or digit structure.
  Two measurements over 2 million random bodies each put that at about 1 in
  38,000 and 1 in 60,000.

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
