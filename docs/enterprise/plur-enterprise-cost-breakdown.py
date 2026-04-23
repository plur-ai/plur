#!/usr/bin/env python3
"""Generate PLUR Enterprise cost breakdown — formula-driven, adjustable."""

from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill

wb = Workbook()
ws = wb.active
ws.title = "Cost Breakdown"

# --- Styles ---
header_font = Font(name="Calibri", size=14, bold=True)
section_font = Font(name="Calibri", size=12, bold=True, color="FFFFFF")
section_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")
subsection_font = Font(name="Calibri", size=11, bold=True)
subsection_fill = PatternFill(start_color="D6E4F0", end_color="D6E4F0", fill_type="solid")
body_font = Font(name="Calibri", size=11)
total_font = Font(name="Calibri", size=11, bold=True)
grand_font = Font(name="Calibri", size=12, bold=True)
discount_font = Font(name="Calibri", size=12, bold=True, color="2E7D32")
discount_fill = PatternFill(start_color="E8F5E9", end_color="E8F5E9", fill_type="solid")
grey_font = Font(name="Calibri", size=11, color="999999")
note_font = Font(name="Calibri", size=10, color="666666")
italic_grey = Font(name="Calibri", size=11, italic=True, color="666666")
recurring_fill = PatternFill(start_color="FFF3E0", end_color="FFF3E0", fill_type="solid")
recurring_font = Font(name="Calibri", size=12, bold=True, color="E65100")
param_fill = PatternFill(start_color="FFFDE7", end_color="FFFDE7", fill_type="solid")
param_font = Font(name="Calibri", size=11, bold=True, color="E65100")
thin_border = Border(bottom=Side(style="thin", color="CCCCCC"))
thick_border = Border(top=Side(style="medium", color="2F5496"), bottom=Side(style="medium", color="2F5496"))
phase_border = Border(top=Side(style="thin", color="2F5496"), bottom=Side(style="thin", color="2F5496"))
eur_fmt = '#,##0 "EUR"'
NUM_COLS = 8

# Column widths
ws.column_dimensions["A"].width = 4
ws.column_dimensions["B"].width = 56
ws.column_dimensions["C"].width = 11
ws.column_dimensions["D"].width = 11
ws.column_dimensions["E"].width = 11
ws.column_dimensions["F"].width = 11
ws.column_dimensions["G"].width = 11
ws.column_dimensions["H"].width = 16

def style_param_cell(cell):
    """Mark a cell as an adjustable parameter."""
    cell.fill = param_fill
    cell.font = param_font
    cell.border = Border(
        left=Side(style="thin", color="E65100"),
        right=Side(style="thin", color="E65100"),
        top=Side(style="thin", color="E65100"),
        bottom=Side(style="thin", color="E65100"),
    )

def set_row_border(ws, row, border, cols=NUM_COLS):
    for col in range(1, cols + 1):
        ws.cell(row=row, column=col).border = border

# ===== DATA =====
team_info = [
    ("Gregor", "Project Director, Lead Dev"),
    ("Tadej", "CTO, Tech Lead"),
    ("Marko", "DevOps"),
    ("Crt", "PM, Data Scientist"),
]

phases = [
    {
        "name": "Phase 1 \u2014 Shared Memory (50 users)",
        "token_cost": 1450,
        "items": [
            ("PostgreSQL backend with graph (AGE) + vector search",      8,  20,  4,  0),
            ("Multi-user MCP server (HTTP/SSE transport)",               4,  16,  0,  0),
            ("GitLab SSO integration (OAuth2/OIDC + PKCE)",              0,  20,  0,  0),
            ("Scope-based access control + role-level permissions",      0,  24,  0,  0),
            ("MCP tool security (allowlist, write enforcement)",         4,  12,  0,  0),
            ("Structured logging, audit trail & PII handling",           0,   8,  4,  0),
            ("Admin dashboard (usage, health, audit log)",              24,   8,  0,  0),
            ("Monitoring & alerting",                                    0,   0, 12,  0),
            ("Server deployment (TLS, CI/CD, backups)",                  0,   4, 16,  0),
            ("IDE compatibility validation & documentation",             0,   4,  0,  8),
            ("Onboarding all 50 users",                                  4,   0,  0, 12),
        ],
    },
    {
        "name": "Phase 2 \u2014 Knowledge Engineering",
        "token_cost": 580,
        "items": [
            ("Repo scanning pipeline (1,400 repos \u2014 configs, CI, docs)", 0, 8, 0, 16),
            ("Convention & pattern extraction engine",                    0,  8,  0, 20),
            ("Engram generation + quality tuning (multiple passes)",      8,  0,  0, 12),
            ("Knowledge pack packaging (per-project, per-group, org)",   0,  8,  0,  8),
            ("Review & curation workflow with tech leads",               8,  0,  0,  8),
            ("Quality feedback loop (signals tune extraction)",          0,  4,  0,  8),
            ("New project hook (auto-extraction on repo creation)",      0,  8,  8,  0),
        ],
    },
    {
        "name": "Phase 3 \u2014 AI Development Team (Datacore Enterprise)",
        "token_cost": 870,
        "items": [
            #                                                          Gregor  Tadej  Marko  Crt
            #                                                          Gregor  Tadej  Marko  Crt
            ("AI Chief of Staff \u2014 org-wide operational intelligence",  8,   16,    0,    4),
            ("Insight Agent \u2014 proactive pattern detection & recommendations", 8, 12, 0,  8),
            ("Onboarding Companion \u2014 interactive guide for new developers", 4, 12,  0,   8),
            ("Orchestration engine (task queue, routing, quality gates)",16,  20,    0,    0),
            ("GitLab CI/CD integration (agents triggered from pipelines)", 0, 8,   8,    0),
            ("Dashboard (execution monitoring, success rates, cost)",   12,   8,    0,    0),
            ("Workflow discovery & configuration with client",           4,   0,    0,    8),
        ],
    },
    {
        "name": "Add-on \u2014 GitHub Provider (when needed)",
        "token_cost": 0,
        "items": [
            ("GitHub SSO integration (OAuth + org sync)",                0, 16, 0, 0),
            ("GitHub webhook handler + membership sync",                 0, 8, 4, 0),
        ],
    },
]

support_items = [
    "Security patches, dependency updates & PLUR core upgrades",
    "Infrastructure monitoring, uptime SLA (99.5%), incident response",
    "Knowledge pipeline tuning (extraction quality, pack curation)",
    "New user onboarding (team growth, offboarding cleanup)",
    "Priority bug fixes (< 24h response, < 72h resolution)",
    "Platform evolution (new MCP clients, IDE support, model changes)",
    "AI compute (token budget for agents, extraction, orchestration)",
    "Quarterly review & optimization session",
]

# ===== RENDER =====
row = 1
ws.merge_cells("A1:H1")
ws["A1"].value = "PLUR Enterprise \u2014 Cost Breakdown"
ws["A1"].font = header_font
row = 3

# ===== PARAMETERS (adjustable) =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="Parameters (adjust yellow cells)").font = Font(name="Calibri", size=12, bold=True, color="E65100")
row += 1

params = {}  # name -> cell reference

def add_param(r, label, value, fmt=None):
    ws.cell(row=r, column=2, value=label).font = Font(name="Calibri", size=11, bold=True)
    c = ws.cell(row=r, column=3, value=value)
    style_param_cell(c)
    c.alignment = Alignment(horizontal="right")
    if fmt:
        c.number_format = fmt
    return f"$C${r}"

params["rate"] = add_param(row, "Hourly rate (EUR)", 85, '#,##0')
row += 1
params["discount"] = add_param(row, "Design partner discount", 0.20, '0%')
row += 1
params["support_base"] = add_param(row, "Monthly support retainer (EUR)", 2500, '#,##0')
row += 1
params["support_tokens"] = add_param(row, "Monthly token budget (EUR)", 150, '#,##0')
row += 1
params["infra_monthly"] = add_param(row, "Monthly infrastructure (EUR)", 100, '#,##0')
row += 1
params["support_months_y1"] = add_param(row, "Support months in year 1", 9, '0')
row += 1
row += 1

# --- Team ---
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="Team").font = Font(name="Calibri", size=12, bold=True)
row += 1
for name, role in team_info:
    ws.cell(row=row, column=2, value=name).font = Font(name="Calibri", size=11, bold=True)
    ws.cell(row=row, column=3, value=role).font = body_font
    ws.merge_cells(start_row=row, start_column=3, end_row=row, end_column=NUM_COLS)
    row += 1
row += 1

# ===== SECTION 1: PROJECT DELIVERY =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="PROJECT DELIVERY").font = Font(name="Calibri", size=13, bold=True)
row += 1

headers = ["#", "Deliverable", "Gregor", "Tadej", "Marko", "Crt", "Total h", "Cost (EUR)"]
for col, h in enumerate(headers, 1):
    c = ws.cell(row=row, column=col, value=h)
    c.font = section_font
    c.fill = section_fill
    c.alignment = Alignment(horizontal="left" if col <= 2 else "right")
row += 1

phase_subtotal_rows = []  # (subtotal_row, token_row)
item_rows_all = []  # all item rows for grand total

for phase in phases:
    # Phase header
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=NUM_COLS)
    ws.cell(row=row, column=1, value=phase["name"]).font = subsection_font
    ws.cell(row=row, column=1).fill = subsection_fill
    row += 1

    item_rows = []

    for idx, item in enumerate(phase["items"], 1):
        desc = item[0]
        person_hours = list(item[1:5])

        ws.cell(row=row, column=1, value=idx).font = body_font
        ws.cell(row=row, column=1).alignment = Alignment(horizontal="center")
        ws.cell(row=row, column=2, value=desc).font = body_font

        # Person hours — editable
        for i, ph in enumerate(person_hours):
            c = ws.cell(row=row, column=3 + i)
            if ph > 0:
                c.value = ph
                c.font = body_font
                style_param_cell(c)
            else:
                c.value = None
                c.font = Font(name="Calibri", size=11, color="CCCCCC")
            c.alignment = Alignment(horizontal="right")

        # Total hours = SUM(C:F)
        c_h = ws.cell(row=row, column=7)
        c_h.value = f"=SUM(C{row}:F{row})"
        c_h.font = body_font
        c_h.alignment = Alignment(horizontal="right")

        # Cost = Total × Rate
        c_cost = ws.cell(row=row, column=8)
        c_cost.value = f"=G{row}*{params['rate']}"
        c_cost.font = body_font
        c_cost.alignment = Alignment(horizontal="right")
        c_cost.number_format = eur_fmt

        set_row_border(ws, row, thin_border)
        item_rows.append(row)
        item_rows_all.append(row)
        row += 1

    # Phase subtotal
    sub_row = row
    dash = "\u2014"
    phase_short = phase["name"].split(dash)[0].strip()
    ws.cell(row=row, column=2, value=f"Subtotal \u2014 {phase_short}").font = total_font
    for i in range(4):
        col_letter = chr(67 + i)  # C, D, E, F
        c = ws.cell(row=row, column=3 + i)
        first, last = item_rows[0], item_rows[-1]
        c.value = f"=SUM({col_letter}{first}:{col_letter}{last})"
        c.font = total_font
        c.alignment = Alignment(horizontal="right")
    c_h = ws.cell(row=row, column=7)
    c_h.value = f"=SUM(G{item_rows[0]}:G{item_rows[-1]})"
    c_h.font = total_font
    c_h.alignment = Alignment(horizontal="right")
    c_c = ws.cell(row=row, column=8)
    c_c.value = f"=SUM(H{item_rows[0]}:H{item_rows[-1]})"
    c_c.font = total_font
    c_c.alignment = Alignment(horizontal="right")
    c_c.number_format = eur_fmt
    set_row_border(ws, row, phase_border)
    row += 1

    # Token cost row — editable
    tok_row = row
    ws.cell(row=row, column=2, value="AI compute (tokens)").font = italic_grey
    c_tc = ws.cell(row=row, column=8, value=phase["token_cost"])
    style_param_cell(c_tc)
    c_tc.alignment = Alignment(horizontal="right")
    c_tc.number_format = eur_fmt
    set_row_border(ws, row, thin_border)
    row += 1

    phase_subtotal_rows.append((sub_row, tok_row))
    row += 1  # blank

# --- Project total ---
gt_row = row
set_row_border(ws, row, thick_border)
ws.cell(row=row, column=2, value="PROJECT TOTAL").font = grand_font
# Sum person columns across all phases
for i in range(4):
    col_letter = chr(67 + i)
    sub_refs = "+".join(f"{col_letter}{sr}" for sr, _ in phase_subtotal_rows)
    c = ws.cell(row=row, column=3 + i)
    c.value = f"={sub_refs}"
    c.font = grand_font
    c.alignment = Alignment(horizontal="right")
# Total hours
sub_h_refs = "+".join(f"G{sr}" for sr, _ in phase_subtotal_rows)
ws.cell(row=row, column=7, value=f"={sub_h_refs}").font = grand_font
ws.cell(row=row, column=7).alignment = Alignment(horizontal="right")
# Total cost = sum of subtotal costs + token costs
cost_refs = "+".join(f"H{sr}+H{tr}" for sr, tr in phase_subtotal_rows)
c_gc = ws.cell(row=row, column=8, value=f"={cost_refs}")
c_gc.font = grand_font
c_gc.alignment = Alignment(horizontal="right")
c_gc.number_format = eur_fmt
set_row_border(ws, row, thick_border)
row += 1

# Discount
disc_row = row
ws.cell(row=row, column=2, value="Design partner discount").font = Font(name="Calibri", size=11, color="2E7D32")
c_d = ws.cell(row=row, column=8)
c_d.value = f"=-H{gt_row}*{params['discount']}"
c_d.font = Font(name="Calibri", size=11, color="2E7D32")
c_d.alignment = Alignment(horizontal="right")
c_d.number_format = '-#,##0 "EUR"'
row += 1

# Design partner price
dp_row = row
for col in range(1, NUM_COLS + 1):
    ws.cell(row=row, column=col).fill = discount_fill
    ws.cell(row=row, column=col).border = thick_border
ws.cell(row=row, column=2, value="PROJECT DELIVERY (design partner price)").font = discount_font
c_dp = ws.cell(row=row, column=8)
c_dp.value = f"=H{gt_row}+H{disc_row}"
c_dp.font = discount_font
c_dp.fill = discount_fill
c_dp.alignment = Alignment(horizontal="right")
c_dp.number_format = eur_fmt
row += 3

# ===== SECTION 2: SUPPORT & MAINTENANCE =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="MONTHLY SUPPORT & MAINTENANCE").font = Font(name="Calibri", size=13, bold=True)
row += 1

for col in range(1, NUM_COLS + 1):
    ws.cell(row=row, column=col).fill = section_fill
ws.cell(row=row, column=2, value="Included in monthly retainer").font = section_font
ws.cell(row=row, column=8, value="Monthly").font = section_font
ws.cell(row=row, column=8).alignment = Alignment(horizontal="right")
row += 1

for idx, desc in enumerate(support_items, 1):
    ws.cell(row=row, column=1, value=idx).font = body_font
    ws.cell(row=row, column=1).alignment = Alignment(horizontal="center")
    ws.cell(row=row, column=2, value=desc).font = body_font
    set_row_border(ws, row, thin_border)
    row += 1

row += 1
support_row = row
for col in range(1, NUM_COLS + 1):
    ws.cell(row=row, column=col).fill = recurring_fill
    ws.cell(row=row, column=col).border = thick_border
ws.cell(row=row, column=2, value="MONTHLY RETAINER (50 users)").font = recurring_font
c_s = ws.cell(row=row, column=8)
c_s.value = f"={params['support_base']}+{params['support_tokens']}"
c_s.font = recurring_font
c_s.fill = recurring_fill
c_s.alignment = Alignment(horizontal="right")
c_s.number_format = '#,##0 "EUR/mo"'
row += 1

ws.cell(row=row, column=2, value="Annual support cost").font = grey_font
c_a = ws.cell(row=row, column=8)
c_a.value = f"=H{support_row}*12"
c_a.font = total_font
c_a.alignment = Alignment(horizontal="right")
c_a.number_format = eur_fmt
row += 1

ws.cell(row=row, column=2, value="Support starts after Phase 1 delivery").font = note_font
row += 3

# ===== SECTION 3: FIRST-YEAR SUMMARY =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="FIRST-YEAR ENGAGEMENT SUMMARY").font = Font(name="Calibri", size=13, bold=True)
row += 1

summary_labels = [
    ("Project delivery (Phases 1-3, design partner price)", f"=H{dp_row}"),
    ("Support & maintenance (starts after Phase 1)", f"=H{support_row}*{params['support_months_y1']}"),
    ("Infrastructure (hosting, database \u2014 at cost)", f"={params['infra_monthly']}*{params['support_months_y1']}"),
]
summary_rows = []
for label, formula in summary_labels:
    ws.cell(row=row, column=2, value=label).font = body_font
    c_v = ws.cell(row=row, column=8)
    c_v.value = formula
    c_v.font = body_font
    c_v.alignment = Alignment(horizontal="right")
    c_v.number_format = eur_fmt
    set_row_border(ws, row, thin_border)
    summary_rows.append(row)
    row += 1

# First year total
fy_row = row
for col in range(1, NUM_COLS + 1):
    ws.cell(row=row, column=col).border = thick_border
    ws.cell(row=row, column=col).fill = discount_fill
ws.cell(row=row, column=2, value="FIRST-YEAR TOTAL").font = Font(name="Calibri", size=12, bold=True, color="2E7D32")
sum_refs = "+".join(f"H{r}" for r in summary_rows)
c_t = ws.cell(row=row, column=8)
c_t.value = f"={sum_refs}"
c_t.font = Font(name="Calibri", size=12, bold=True, color="2E7D32")
c_t.fill = discount_fill
c_t.alignment = Alignment(horizontal="right")
c_t.number_format = eur_fmt
row += 3

# ===== PAYMENT SCHEDULE =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="Payment Schedule").font = Font(name="Calibri", size=12, bold=True)
row += 1

sched = [
    ("Phase 1 \u2014 Shared Memory", "Months 1-2", 0),
    ("Phase 2 \u2014 Knowledge Engineering", "Months 2-4", 1),
    ("Phase 3 \u2014 AI Development Team", "Months 4-6", 2),
    ("Add-on \u2014 GitHub Provider", "When needed", 3),
]
for name, timeline, pi in sched:
    sr, tr = phase_subtotal_rows[pi]
    ws.cell(row=row, column=2, value=name).font = body_font
    ws.cell(row=row, column=3, value=timeline).font = body_font
    ws.merge_cells(start_row=row, start_column=3, end_row=row, end_column=6)
    # Standard price
    c_orig = ws.cell(row=row, column=7)
    c_orig.value = f"=H{sr}+H{tr}"
    c_orig.font = grey_font
    c_orig.alignment = Alignment(horizontal="right")
    c_orig.number_format = eur_fmt
    # Discounted
    c_disc = ws.cell(row=row, column=8)
    c_disc.value = f"=G{row}*(1-{params['discount']})"
    c_disc.font = total_font
    c_disc.alignment = Alignment(horizontal="right")
    c_disc.number_format = eur_fmt
    set_row_border(ws, row, thin_border)
    row += 1

# Support line
ws.cell(row=row, column=2, value="Monthly support (ongoing)").font = body_font
ws.cell(row=row, column=3, value="From month 3").font = body_font
ws.merge_cells(start_row=row, start_column=3, end_row=row, end_column=6)
c_sm = ws.cell(row=row, column=8)
c_sm.value = f"=H{support_row}"
c_sm.font = total_font
c_sm.alignment = Alignment(horizontal="right")
c_sm.number_format = '#,##0 "EUR/mo"'
set_row_border(ws, row, thin_border)
row += 2

# ===== TEAM UTILIZATION =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="Team Utilization").font = Font(name="Calibri", size=12, bold=True)
row += 1

for i, (name, role) in enumerate(team_info):
    col_letter = chr(67 + i)
    ws.cell(row=row, column=2, value=f"{name} ({role})").font = body_font
    # Percentage
    c_pct = ws.cell(row=row, column=6)
    c_pct.value = f"={col_letter}{gt_row}/G{gt_row}"
    c_pct.font = body_font
    c_pct.alignment = Alignment(horizontal="right")
    c_pct.number_format = '0%'
    # Hours
    c_h = ws.cell(row=row, column=7)
    c_h.value = f"={col_letter}{gt_row}"
    c_h.font = total_font
    c_h.alignment = Alignment(horizontal="right")
    # Cost
    c_c = ws.cell(row=row, column=8)
    c_c.value = f"=G{row}*{params['rate']}"
    c_c.font = total_font
    c_c.alignment = Alignment(horizontal="right")
    c_c.number_format = eur_fmt
    set_row_border(ws, row, thin_border)
    row += 1

row += 2

# ===== DESIGN PARTNER BENEFITS =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="Design Partner Benefits").font = Font(name="Calibri", size=12, bold=True)
row += 1

benefits = [
    "Influence on product roadmap \u2014 your requirements built first",
    "White-label & reseller rights (future phase, pre-negotiated)",
    "Case study & reference customer agreement",
    "Priority support with dedicated team",
    "Quarterly product review & roadmap alignment sessions",
]
for b in benefits:
    ws.cell(row=row, column=2, value=f"  {b}").font = body_font
    row += 1
row += 2

# ===== NOTES =====
ws.merge_cells(f"A{row}:H{row}")
ws.cell(row=row, column=1, value="Notes").font = Font(name="Calibri", size=12, bold=True)
row += 1
notes = [
    "All prices exclude VAT.",
    "Project hours invoiced on actuals with weekly reporting.",
    "Design partner pricing valid for 12 months from contract start.",
    "Infrastructure costs (DO droplet, managed Postgres) billed at cost.",
    "Support retainer covers up to 50 users. Additional users: 30 EUR/user/month.",
    "We use Claude Code and AI-assisted development extensively \u2014 this is how we deliver fast.",
    "Yellow cells are adjustable \u2014 all totals recalculate automatically.",
]
for n in notes:
    ws.cell(row=row, column=2, value=f"  {n}").font = note_font
    ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=NUM_COLS)
    row += 1

# --- Save ---
ws.print_area = f"A1:H{row}"
out = "/Users/gregor/Data/5-plur/2-projects/plur/docs/enterprise/PLUR-Enterprise-Cost-Breakdown.xlsx"
wb.save(out)
print(f"Saved: {out}")
print(f"All yellow cells are adjustable. Formulas recalculate automatically.")
print(f"Key params at top: rate, discount %, support base, token budget, infra, support months")
