#!/usr/bin/env python3
"""PLUR Enterprise — platform fee + custom services + retainer. Two sheets."""

from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill

wb = Workbook()

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
platform_fill = PatternFill(start_color="E3F2FD", end_color="E3F2FD", fill_type="solid")
platform_font = Font(name="Calibri", size=12, bold=True, color="1565C0")
annual_fill = PatternFill(start_color="E8F5E9", end_color="E8F5E9", fill_type="solid")
annual_font = Font(name="Calibri", size=13, bold=True, color="1B5E20")
margin_fill = PatternFill(start_color="F3E5F5", end_color="F3E5F5", fill_type="solid")
margin_font = Font(name="Calibri", size=12, bold=True, color="6A1B9A")
thin_border = Border(bottom=Side(style="thin", color="CCCCCC"))
thick_border = Border(top=Side(style="medium", color="2F5496"), bottom=Side(style="medium", color="2F5496"))
phase_border = Border(top=Side(style="thin", color="2F5496"), bottom=Side(style="thin", color="2F5496"))
eur_fmt = '#,##0 "EUR"'

def style_param(cell):
    cell.fill = param_fill
    cell.font = param_font
    cell.border = Border(
        left=Side(style="thin", color="E65100"), right=Side(style="thin", color="E65100"),
        top=Side(style="thin", color="E65100"), bottom=Side(style="thin", color="E65100"),
    )

# ===== DATA =====
team_info = [
    ("Gregor", "Project Director, Lead Dev"),
    ("Tadej", "CTO, Tech Lead"),
    ("Marko", "DevOps"),
    ("Crt", "PM, Data Scientist"),
]

# Platform setup fees — flat, bundled, not hourly
platform_fees = [
    {
        "name": "Quick Start \u2014 Platform Setup",
        "desc": "PLUR Enterprise server, PostgreSQL+AGE+pgvector, GitLab SSO, permissions, MCP security, deployment with TLS & CI/CD",
        "fee": 8000,
    },
    {
        "name": "Phase 1 \u2014 Platform Scale",
        "desc": "Role-level permissions, admin dashboard, structured logging & audit trail, monitoring & alerting, CI/CD hardening",
        "fee": 6000,
    },
    {
        "name": "Phase 3 \u2014 Orchestration Platform",
        "desc": "Datacore Enterprise orchestration engine, GitLab CI/CD integration, execution dashboard",
        "fee": 5000,
    },
]

# Custom services — hourly, per-phase, defensible
# (description, gregor, tadej, marko, crt)
custom_phases = [
    {
        "name": "Quick Start \u2014 Your Environment",
        "token_cost": 500,
        "items": [
            #                                                                   Gr  Ta  Ma  Crt
            ("Project kick-off, planning & requirements alignment",              0,  0,  0,  8),
            ("Bootstrapping \u2014 scan 3-5 active repos, create seed engrams",  4,  0,  0,  8),
            ("Onboarding 10-15 pilot users (hands-on setup & training)",         4,  0,  0,  8),
            ("Phase report & deliverables review with stakeholders",             0,  0,  0,  4),
        ],
    },
    {
        "name": "Phase 1 \u2014 Scale to 50 Users",
        "token_cost": 400,
        "items": [
            ("Phase planning & milestone definition",                             0,  0,  0,  4),
            ("IDE compatibility validation for your tool stack",                  0,  4,  0,  8),
            ("Onboarding remaining 35-40 users",                                 0,  0,  0, 12),
            ("Progress tracking, weekly status updates",                          0,  0,  0,  8),
            ("Phase report & deliverables handover",                              0,  0,  0,  4),
        ],
    },
    {
        "name": "Phase 2 \u2014 Knowledge Engineering (your codebase)",
        "token_cost": 580,
        "items": [
            ("Phase planning & extraction strategy",                              0,  0,  0,  6),
            ("Scan 1,400 repos \u2014 configs, CI, linters, docs",              0,  0,  0, 16),
            ("Convention & pattern extraction from your codebase",               0,  0,  0, 20),
            ("Engram generation + quality tuning (multiple passes)",             8,  0,  0, 12),
            ("Knowledge pack packaging (per-project, per-group, org-wide)",      0,  8,  0,  8),
            ("Review & curation workflow with your tech leads",                  8,  0,  0,  8),
            ("Quality feedback loop (your tech leads' signals tune extraction)", 0,  4,  0,  8),
            ("New project hook \u2014 auto-extraction on repo creation",         0,  8,  8,  0),
            ("Progress tracking, weekly status updates",                          0,  0,  0,  8),
            ("Phase report, knowledge coverage analysis & deliverables review",  0,  0,  0,  6),
        ],
    },
    {
        "name": "Phase 3 \u2014 AI Development Team (your org)",
        "token_cost": 870,
        "items": [
            ("Phase planning & workflow discovery with your team",               4,  0,  0,  8),
            ("AI Chief of Staff \u2014 configured for your org structure",       8, 16,  0,  4),
            ("Insight Agent \u2014 tuned to your knowledge graph",              8, 12,  0,  8),
            ("Onboarding Companion \u2014 built from your conventions",         4, 12,  0,  8),
            ("Agent testing & validation with your team",                        0,  0,  0,  8),
            ("Progress tracking, weekly status updates",                          0,  0,  0,  8),
            ("Final report, outcomes documentation & handover",                  0,  0,  0,  6),
        ],
    },
]

# Add-on (separate)
addon = {
    "name": "Add-on \u2014 GitHub Provider (when needed)",
    "fee": 2400,
    "desc": "GitHub SSO, OAuth, org sync, webhook handler \u2014 enables multi-provider support",
}

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


def render_sheet(ws, internal=False):
    NC = 8  # A:# B:desc C:Gregor D:Tadej E:Marko F:Crt G:total H:cost
    COL_P0 = 3  # first person col
    COL_TOTAL = 7
    COL_COST = 8

    ws.column_dimensions["A"].width = 4
    ws.column_dimensions["B"].width = 58
    ws.column_dimensions["C"].width = 11
    ws.column_dimensions["D"].width = 11
    ws.column_dimensions["E"].width = 11
    ws.column_dimensions["F"].width = 11
    ws.column_dimensions["G"].width = 11
    ws.column_dimensions["H"].width = 16

    def pcol(i): return chr(ord('C') + i)
    def brd(r, b=thin_border):
        for c in range(1, NC + 1):
            ws.cell(row=r, column=c).border = b

    row = 1
    ws.merge_cells(f"A1:H1")
    t = "PLUR Enterprise \u2014 Cost Breakdown (INTERNAL)" if internal else "PLUR Enterprise \u2014 Cost Breakdown"
    ws["A1"].value = t
    ws["A1"].font = header_font
    row = 3

    # === PARAMETERS ===
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="Parameters (adjust yellow cells)").font = Font(name="Calibri", size=12, bold=True, color="E65100")
    row += 1

    params = {}
    def add_p(r, label, val, fmt=None):
        ws.cell(row=r, column=2, value=label).font = Font(name="Calibri", size=11, bold=True)
        c = ws.cell(row=r, column=3, value=val)
        style_param(c)
        c.alignment = Alignment(horizontal="right")
        if fmt: c.number_format = fmt
        return f"$C${r}"

    params["rate"] = add_p(row, "Hourly rate (EUR)", 85, '#,##0'); row += 1
    params["discount"] = add_p(row, "Design partner discount", 0.20, '0%'); row += 1
    params["support_base"] = add_p(row, "Monthly support retainer (EUR)", 2500, '#,##0'); row += 1
    params["support_tokens"] = add_p(row, "Monthly token budget (EUR)", 150, '#,##0'); row += 1
    params["infra"] = add_p(row, "Monthly infrastructure (EUR)", 100, '#,##0'); row += 1
    params["commitment"] = add_p(row, "Annual commitment (months)", 12, '0'); row += 1
    if internal:
        params["int_rate"] = add_p(row, "Internal team rate (EUR)", 60, '#,##0'); row += 1
    row += 1

    # Team
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="Team").font = Font(name="Calibri", size=12, bold=True)
    row += 1
    for name, role in team_info:
        ws.cell(row=row, column=2, value=name).font = Font(name="Calibri", size=11, bold=True)
        ws.cell(row=row, column=3, value=role).font = body_font
        ws.merge_cells(start_row=row, start_column=3, end_row=row, end_column=NC)
        row += 1
    row += 1

    # ================================================================
    # SECTION 1: PLATFORM SETUP (flat fees)
    # ================================================================
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="1. PLATFORM SETUP (one-time)").font = Font(name="Calibri", size=13, bold=True)
    row += 1

    ws.merge_cells(f"A{row}:G{row}")
    ws.cell(row=row, column=1, value="PLUR Enterprise platform \u2014 deployed and configured for your infrastructure").font = italic_grey
    row += 1

    platform_rows = []
    for idx, pf in enumerate(platform_fees, 1):
        ws.cell(row=row, column=1, value=idx).font = body_font
        ws.cell(row=row, column=1).alignment = Alignment(horizontal="center")
        ws.cell(row=row, column=2, value=pf["name"]).font = total_font
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=6)
        c = ws.cell(row=row, column=COL_COST, value=pf["fee"])
        style_param(c)
        c.alignment = Alignment(horizontal="right")
        c.number_format = eur_fmt
        brd(row)
        row += 1
        # Description
        ws.cell(row=row, column=2, value=pf["desc"]).font = note_font
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=NC)
        platform_rows.append(row - 1)
        row += 1

    # Platform subtotal
    plat_total_row = row
    brd(row, phase_border)
    ws.cell(row=row, column=2, value="Platform setup total").font = total_font
    c = ws.cell(row=row, column=COL_COST)
    c.value = f"={'+'.join(f'H{r}' for r in platform_rows)}"
    c.font = total_font
    c.alignment = Alignment(horizontal="right")
    c.number_format = eur_fmt
    row += 1

    # Add-on
    addon_row = row
    ws.cell(row=row, column=2, value=addon["name"]).font = body_font
    ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=6)
    c = ws.cell(row=row, column=COL_COST, value=addon["fee"])
    style_param(c)
    c.alignment = Alignment(horizontal="right")
    c.number_format = eur_fmt
    brd(row)
    row += 1
    ws.cell(row=row, column=2, value=addon["desc"]).font = note_font
    ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=NC)
    row += 2

    # ================================================================
    # SECTION 2: CUSTOM SERVICES (hourly)
    # ================================================================
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="2. CUSTOM SERVICES (your organization)").font = Font(name="Calibri", size=13, bold=True)
    row += 1

    # Column headers
    hdrs = ["#", "Deliverable", "Gregor", "Tadej", "Marko", "Crt", "Total h", "Cost (EUR)"]
    for col, h in enumerate(hdrs, 1):
        c = ws.cell(row=row, column=col, value=h)
        c.font = section_font
        c.fill = section_fill
        c.alignment = Alignment(horizontal="left" if col <= 2 else "right")
    row += 1

    custom_subtotal_rows = []
    all_custom_hours_row = None  # we'll track the grand subtotal row

    for phase in custom_phases:
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=NC)
        ws.cell(row=row, column=1, value=phase["name"]).font = subsection_font
        ws.cell(row=row, column=1).fill = subsection_fill
        row += 1

        item_rows = []
        for idx, item in enumerate(phase["items"], 1):
            desc = item[0]
            phrs = list(item[1:5])

            ws.cell(row=row, column=1, value=idx).font = body_font
            ws.cell(row=row, column=1).alignment = Alignment(horizontal="center")
            ws.cell(row=row, column=2, value=desc).font = body_font

            for i, ph in enumerate(phrs):
                c = ws.cell(row=row, column=COL_P0 + i)
                if ph > 0:
                    c.value = ph
                    c.font = body_font
                    style_param(c)
                else:
                    c.value = None
                c.alignment = Alignment(horizontal="right")

            ws.cell(row=row, column=COL_TOTAL, value=f"=SUM(C{row}:F{row})").font = body_font
            ws.cell(row=row, column=COL_TOTAL).alignment = Alignment(horizontal="right")
            c = ws.cell(row=row, column=COL_COST, value=f"=G{row}*{params['rate']}")
            c.font = body_font
            c.alignment = Alignment(horizontal="right")
            c.number_format = eur_fmt
            brd(row)
            item_rows.append(row)
            row += 1

        # Phase subtotal
        sub_row = row
        dash = "\u2014"
        short = phase["name"].split(dash)[0].strip()
        ws.cell(row=row, column=2, value=f"Subtotal \u2014 {short}").font = total_font
        for i in range(4):
            pl = pcol(i)
            c = ws.cell(row=row, column=COL_P0 + i)
            c.value = f"=SUM({pl}{item_rows[0]}:{pl}{item_rows[-1]})"
            c.font = total_font
            c.alignment = Alignment(horizontal="right")
        ws.cell(row=row, column=COL_TOTAL, value=f"=SUM(G{item_rows[0]}:G{item_rows[-1]})").font = total_font
        ws.cell(row=row, column=COL_TOTAL).alignment = Alignment(horizontal="right")
        c = ws.cell(row=row, column=COL_COST, value=f"=SUM(H{item_rows[0]}:H{item_rows[-1]})")
        c.font = total_font
        c.alignment = Alignment(horizontal="right")
        c.number_format = eur_fmt
        brd(row, phase_border)
        row += 1

        # Token cost
        tok_row = row
        ws.cell(row=row, column=2, value="AI compute (tokens)").font = italic_grey
        c = ws.cell(row=row, column=COL_COST, value=phase["token_cost"])
        style_param(c)
        c.alignment = Alignment(horizontal="right")
        c.number_format = eur_fmt
        brd(row)
        row += 1

        custom_subtotal_rows.append((sub_row, tok_row))
        row += 1

    # Custom services total
    cust_total_row = row
    brd(row, thick_border)
    ws.cell(row=row, column=2, value="CUSTOM SERVICES TOTAL").font = grand_font
    h_refs = "+".join(f"G{sr}" for sr, _ in custom_subtotal_rows)
    ws.cell(row=row, column=COL_TOTAL, value=f"={h_refs}").font = grand_font
    ws.cell(row=row, column=COL_TOTAL).alignment = Alignment(horizontal="right")
    cost_refs = "+".join(f"H{sr}+H{tr}" for sr, tr in custom_subtotal_rows)
    c = ws.cell(row=row, column=COL_COST, value=f"={cost_refs}")
    c.font = grand_font
    c.alignment = Alignment(horizontal="right")
    c.number_format = eur_fmt
    brd(row, thick_border)
    row += 2

    # ================================================================
    # PROJECT TOTAL (platform + custom)
    # ================================================================
    proj_total_row = row
    brd(row, thick_border)
    ws.cell(row=row, column=2, value="PROJECT TOTAL (platform + custom)").font = grand_font
    c = ws.cell(row=row, column=COL_COST)
    c.value = f"=H{plat_total_row}+H{cust_total_row}"
    c.font = grand_font
    c.alignment = Alignment(horizontal="right")
    c.number_format = eur_fmt
    brd(row, thick_border)
    row += 1

    # Discount
    disc_row = row
    ws.cell(row=row, column=2, value="Design partner discount").font = Font(name="Calibri", size=11, color="2E7D32")
    c = ws.cell(row=row, column=COL_COST)
    c.value = f"=-H{proj_total_row}*{params['discount']}"
    c.font = Font(name="Calibri", size=11, color="2E7D32")
    c.alignment = Alignment(horizontal="right")
    c.number_format = '-#,##0 "EUR"'
    row += 1

    dp_row = row
    for col in range(1, NC + 1):
        ws.cell(row=row, column=col).fill = discount_fill
        ws.cell(row=row, column=col).border = thick_border
    ws.cell(row=row, column=2, value="PROJECT TOTAL (design partner price)").font = discount_font
    c = ws.cell(row=row, column=COL_COST)
    c.value = f"=H{proj_total_row}+H{disc_row}"
    c.font = discount_font
    c.fill = discount_fill
    c.alignment = Alignment(horizontal="right")
    c.number_format = eur_fmt
    row += 3

    # ================================================================
    # SECTION 3: MONTHLY SUPPORT
    # ================================================================
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="3. MONTHLY SUPPORT & MAINTENANCE").font = Font(name="Calibri", size=13, bold=True)
    row += 1

    for col in range(1, NC + 1):
        ws.cell(row=row, column=col).fill = section_fill
    ws.cell(row=row, column=2, value="Included in monthly retainer").font = section_font
    ws.cell(row=row, column=COL_COST, value="Monthly").font = section_font
    ws.cell(row=row, column=COL_COST).alignment = Alignment(horizontal="right")
    row += 1

    for idx, desc in enumerate(support_items, 1):
        ws.cell(row=row, column=1, value=idx).font = body_font
        ws.cell(row=row, column=1).alignment = Alignment(horizontal="center")
        ws.cell(row=row, column=2, value=desc).font = body_font
        brd(row)
        row += 1

    row += 1
    support_row = row
    for col in range(1, NC + 1):
        ws.cell(row=row, column=col).fill = recurring_fill
        ws.cell(row=row, column=col).border = thick_border
    ws.cell(row=row, column=2, value="MONTHLY RETAINER (50 users)").font = recurring_font
    c = ws.cell(row=row, column=COL_COST)
    c.value = f"={params['support_base']}+{params['support_tokens']}"
    c.font = recurring_font
    c.fill = recurring_fill
    c.alignment = Alignment(horizontal="right")
    c.number_format = '#,##0 "EUR/mo"'
    row += 3

    # ================================================================
    # ANNUAL COMMITMENT
    # ================================================================
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="ANNUAL COMMITMENT (12 months)").font = Font(name="Calibri", size=13, bold=True)
    row += 1

    annual_items = [
        ("Platform setup (one-time)", f"=H{plat_total_row}"),
        ("Custom services (one-time)", f"=H{cust_total_row}"),
        ("Design partner discount", f"=H{disc_row}"),
        ("Support & maintenance (12 months)", f"=H{support_row}*{params['commitment']}"),
        ("Infrastructure (at cost)", f"={params['infra']}*{params['commitment']}"),
    ]
    a_rows = []
    for label, formula in annual_items:
        ws.cell(row=row, column=2, value=label).font = body_font
        c = ws.cell(row=row, column=COL_COST)
        c.value = formula
        c.font = body_font
        c.alignment = Alignment(horizontal="right")
        c.number_format = eur_fmt
        brd(row)
        a_rows.append(row)
        row += 1

    at_row = row
    for col in range(1, NC + 1):
        ws.cell(row=row, column=col).border = thick_border
        ws.cell(row=row, column=col).fill = annual_fill
    ws.cell(row=row, column=2, value="ANNUAL COMMITMENT TOTAL").font = annual_font
    c = ws.cell(row=row, column=COL_COST)
    c.value = f"={'+'.join(f'H{r}' for r in a_rows)}"
    c.font = annual_font
    c.fill = annual_fill
    c.alignment = Alignment(horizontal="right")
    c.number_format = eur_fmt
    row += 1

    ws.cell(row=row, column=2, value="Monthly equivalent").font = grey_font
    c = ws.cell(row=row, column=COL_COST)
    c.value = f"=H{at_row}/{params['commitment']}"
    c.font = total_font
    c.alignment = Alignment(horizontal="right")
    c.number_format = '#,##0 "EUR/mo"'
    row += 3

    # ================================================================
    # INTERNAL: MARGIN ANALYSIS
    # ================================================================
    if internal:
        ws.merge_cells(f"A{row}:H{row}")
        ws.cell(row=row, column=1, value="MARGIN ANALYSIS (INTERNAL ONLY)").font = margin_font
        row += 1

        rev_row = row
        ws.cell(row=row, column=2, value="Project revenue (design partner)").font = body_font
        c = ws.cell(row=row, column=COL_COST, value=f"=H{dp_row}")
        c.font = body_font; c.alignment = Alignment(horizontal="right"); c.number_format = eur_fmt
        brd(row); row += 1

        plat_cost_row = row
        ws.cell(row=row, column=2, value="Platform internal cost (mostly built \u2014 estimate)").font = body_font
        c = ws.cell(row=row, column=COL_COST, value=3000)
        style_param(c); c.alignment = Alignment(horizontal="right"); c.number_format = eur_fmt
        brd(row); row += 1

        cust_cost_row = row
        ws.cell(row=row, column=2, value="Custom services internal cost (hours \u00d7 internal rate)").font = body_font
        c = ws.cell(row=row, column=COL_COST)
        c.value = f"=G{cust_total_row}*{params['int_rate']}"
        c.font = body_font; c.alignment = Alignment(horizontal="right"); c.number_format = eur_fmt
        brd(row); row += 1

        mg_row = row
        for col in range(1, NC + 1):
            ws.cell(row=row, column=col).fill = margin_fill
            ws.cell(row=row, column=col).border = thick_border
        ws.cell(row=row, column=2, value="PROJECT MARGIN").font = margin_font
        c = ws.cell(row=row, column=COL_COST)
        c.value = f"=H{rev_row}-H{plat_cost_row}-H{cust_cost_row}"
        c.font = margin_font; c.fill = margin_fill
        c.alignment = Alignment(horizontal="right"); c.number_format = eur_fmt
        row += 1

        ws.cell(row=row, column=2, value="Margin %").font = grey_font
        c = ws.cell(row=row, column=COL_COST)
        c.value = f"=H{mg_row}/H{rev_row}"
        c.font = total_font; c.alignment = Alignment(horizontal="right"); c.number_format = '0%'
        row += 1

        sup_mg_row = row
        ws.cell(row=row, column=2, value="Annual support margin (retainer \u2212 ~8h/mo internal)").font = grey_font
        c = ws.cell(row=row, column=COL_COST)
        c.value = f"=(H{support_row}-8*{params['int_rate']})*{params['commitment']}"
        c.font = total_font; c.alignment = Alignment(horizontal="right"); c.number_format = eur_fmt
        row += 1

        ws.cell(row=row, column=2, value="TOTAL ANNUAL MARGIN").font = margin_font
        c = ws.cell(row=row, column=COL_COST)
        c.value = f"=H{mg_row}+H{sup_mg_row}"
        c.font = margin_font; c.alignment = Alignment(horizontal="right"); c.number_format = eur_fmt
        row += 3

    # ================================================================
    # PAYMENT SCHEDULE
    # ================================================================
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="Payment Schedule").font = Font(name="Calibri", size=12, bold=True)
    row += 1

    sched = [
        ("Quick Start (platform + custom)", "Weeks 1-3"),
        ("Phase 1 \u2014 Scale to 50", "Months 1-3"),
        ("Phase 2 \u2014 Knowledge Engineering", "Months 3-5"),
        ("Phase 3 \u2014 AI Development Team", "Months 5-7"),
        ("Monthly support (12-month commitment)", "Ongoing"),
    ]
    for name, timeline in sched:
        ws.cell(row=row, column=2, value=name).font = body_font
        ws.cell(row=row, column=3, value=timeline).font = body_font
        ws.merge_cells(start_row=row, start_column=3, end_row=row, end_column=6)
        brd(row)
        row += 1
    row += 2

    # ================================================================
    # BENEFITS
    # ================================================================
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="Design Partner Benefits").font = Font(name="Calibri", size=12, bold=True)
    row += 1
    for b in [
        "Influence on product roadmap \u2014 your requirements built first",
        "White-label & reseller rights (future phase, pre-negotiated)",
        "Case study & reference customer agreement",
        "Priority support with dedicated team",
        "Quarterly product review & roadmap alignment sessions",
    ]:
        ws.cell(row=row, column=2, value=f"  {b}").font = body_font
        row += 1
    row += 2

    # ================================================================
    # NOTES
    # ================================================================
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value="Notes").font = Font(name="Calibri", size=12, bold=True)
    row += 1
    notes = [
        "All prices exclude VAT.",
        "Platform fees are flat \u2014 one-time setup, not hourly.",
        "Custom services invoiced on actuals with weekly reporting.",
        "12-month support commitment \u2014 retainer locked for the full year.",
        "Infrastructure (hosting, database) billed at cost.",
        "Support covers up to 50 users. Additional users: 30 EUR/user/month.",
        "We use Claude Code and AI-assisted development \u2014 this is how we deliver fast.",
        "Yellow cells are adjustable \u2014 all totals recalculate automatically.",
    ]
    if internal:
        notes.append("INTERNAL SHEET \u2014 do not share with client.")
    for n in notes:
        ws.cell(row=row, column=2, value=f"  {n}").font = note_font
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=NC)
        row += 1

    ws.print_area = f"A1:H{row}"


# ===== Generate =====
ws_client = wb.active
ws_client.title = "Client"
render_sheet(ws_client, internal=False)

ws_internal = wb.create_sheet("Internal")
render_sheet(ws_internal, internal=True)

out = "/Users/gregor/Data/5-plur/2-projects/plur/docs/enterprise/PLUR-Enterprise-Cost-Breakdown.xlsx"
wb.save(out)
print(f"Saved: {out}")
print("Client sheet: platform fees (flat) + custom services (hourly) + retainer")
print("Internal sheet: + margin analysis with internal rate")
