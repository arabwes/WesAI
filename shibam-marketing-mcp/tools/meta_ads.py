"""Meta Ads MCP tools — 4 tools covering campaign performance, KPIs, objective breakdown, and creative performance."""
import logging
from typing import Optional
from facebook_business.adobjects.campaign import Campaign
from facebook_business.adobjects.ad import Ad
from clients.meta_client import get_account
from utils.date_helpers import to_meta_time_range
from utils.kpi_status import meta_cpm_status, meta_link_ctr_status, meta_frequency_status, alert
from utils.formatting import fmt_currency, fmt_pct, fmt_number, fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_CAMPAIGN_INSIGHT_FIELDS = [
    "campaign_name", "objective", "reach", "impressions", "cpm",
    "inline_link_clicks", "inline_link_click_ctr", "frequency",
    "spend", "cost_per_result", "actions",
]
_AD_INSIGHT_FIELDS = [
    "ad_name", "impressions", "inline_link_click_ctr", "frequency", "spend",
]


def _parse_insights(campaigns, insight_fields: list, time_params: dict) -> list:
    """Fetch insights for a list of campaign objects and return raw dicts."""
    results = []
    for campaign in campaigns:
        params = {**time_params, "level": "campaign"}
        insights = campaign.get_insights(fields=insight_fields, params=params)
        results.extend(list(insights))
    return results


@api_retry()
async def meta_ads_campaign_performance(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Fetch Meta Ads campaign performance metrics.

    Returns campaign name, objective, reach, impressions, CPM, link clicks,
    link CTR, frequency, spend, and cost per result.

    Always queries account act_817875271884127 explicitly.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    try:
        account = get_account()
        time_params = to_meta_time_range(date_range, start_date, end_date)
        campaigns = account.get_campaigns(fields=["name", "objective", "status"])
        active = [c for c in campaigns if c.get("status") == "ACTIVE"]

        if not active:
            return f"No active Meta campaigns found for {date_range}."

        rows = []
        for campaign in active:
            params = {**time_params, "level": "campaign"}
            insights = list(campaign.get_insights(fields=_CAMPAIGN_INSIGHT_FIELDS, params=params))
            if not insights:
                continue
            i = insights[0]
            cpm = float(i.get("cpm", 0))
            ctr = float(i.get("inline_link_click_ctr", 0))
            freq = float(i.get("frequency", 0))
            rows.append({
                "Campaign": i.get("campaign_name", campaign.get("name", ""))[:35],
                "Objective": campaign.get("objective", ""),
                "Reach": fmt_number(float(i.get("reach", 0))),
                "Impressions": fmt_number(float(i.get("impressions", 0))),
                "CPM": fmt_currency(cpm),
                "Link Clicks": fmt_number(float(i.get("inline_link_clicks", 0))),
                "Link CTR": fmt_pct(ctr),
                "Frequency": f"{freq:.2f}",
                "Spend": fmt_currency(float(i.get("spend", 0))),
            })

        if not rows:
            return f"No insight data available for the selected period ({date_range})."

        cols = ["Campaign", "Objective", "Reach", "Impressions", "CPM", "Link Clicks", "Link CTR", "Frequency", "Spend"]
        return f"Meta Ads Campaign Performance — {date_range}\n\n" + fmt_table(rows, cols)

    except Exception as e:
        logger.error("meta_ads_campaign_performance failed: %s", e)
        return f"Error fetching Meta Ads campaign performance: {e}"


@api_retry()
async def meta_ads_kpi_check(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Check Meta Ads account-level KPIs against Shibam's targets and return 🟢🟡🔴 status.

    Targets:
      CPM:       🟢 ≤$10   / 🟡 $10–$15 / 🔴 >$15
      Link CTR:  🟢 ≥1.5%  / 🟡 1–1.5%  / 🔴 <1%
      Frequency: 🟢 ≤2.0   / 🟡 2.0–3.0 / 🔴 >3.0

    Immediate alerts: Frequency >3.5, CPM >$15

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    try:
        account = get_account()
        time_params = to_meta_time_range(date_range, start_date, end_date)
        params = {**time_params, "level": "account"}
        account_fields = ["impressions", "reach", "cpm", "inline_link_click_ctr", "frequency", "spend", "inline_link_clicks"]
        insights = list(account.get_insights(fields=account_fields, params=params))

        if not insights:
            return f"No Meta Ads data available for {date_range}."

        i = insights[0]
        cpm = float(i.get("cpm", 0))
        ctr = float(i.get("inline_link_click_ctr", 0))
        freq = float(i.get("frequency", 0))
        spend = float(i.get("spend", 0))
        impressions = float(i.get("impressions", 0))
        reach = float(i.get("reach", 0))
        clicks = float(i.get("inline_link_clicks", 0))

        alerts = []
        if freq > 3.5:
            alerts.append(alert(True, f"Frequency is {freq:.2f} — exceeds 3.5 immediate alert threshold. Audience fatigue likely."))
        if cpm > 15:
            alerts.append(alert(True, f"CPM is {fmt_currency(cpm)} — exceeds $15.00 immediate alert threshold."))

        lines = [
            f"Meta Ads KPI Check — {date_range}",
            f"",
            f"{meta_cpm_status(cpm)}  CPM:        {fmt_currency(cpm)}   (target: ≤$10)",
            f"{meta_link_ctr_status(ctr)}  Link CTR:   {fmt_pct(ctr)}  (target: ≥1.5%)",
            f"{meta_frequency_status(freq)}  Frequency:  {freq:.2f}          (target: ≤2.0)",
            f"",
            f"Volume:  {fmt_number(impressions)} impressions / {fmt_number(reach)} reach / {fmt_number(clicks)} link clicks / {fmt_currency(spend)} spent",
        ]
        if alerts:
            lines += ["", "ALERTS:"] + [f"  {a}" for a in alerts if a]

        return "\n".join(lines)

    except Exception as e:
        logger.error("meta_ads_kpi_check failed: %s", e)
        return f"Error checking Meta Ads KPIs: {e}"


@api_retry()
async def meta_ads_objective_breakdown(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
) -> str:
    """
    Break down Meta Ads spend and performance by campaign objective.

    Highlights the Traffic objective, which historically outperforms for Shibam.

    Args:
        date_range: last_7_days | last_30_days | this_month | last_month | custom
        start_date: YYYY-MM-DD — required only when date_range=custom
        end_date:   YYYY-MM-DD — required only when date_range=custom
    """
    try:
        account = get_account()
        time_params = to_meta_time_range(date_range, start_date, end_date)
        campaigns = account.get_campaigns(fields=["name", "objective", "status"])

        by_objective: dict = {}
        for campaign in campaigns:
            obj = campaign.get("objective", "UNKNOWN")
            params = {**time_params, "level": "campaign"}
            insights = list(campaign.get_insights(
                fields=["spend", "impressions", "inline_link_clicks", "inline_link_click_ctr", "reach"],
                params=params,
            ))
            if not insights:
                continue
            i = insights[0]
            if obj not in by_objective:
                by_objective[obj] = {"spend": 0, "impressions": 0, "clicks": 0, "reach": 0, "campaigns": 0}
            by_objective[obj]["spend"] += float(i.get("spend", 0))
            by_objective[obj]["impressions"] += float(i.get("impressions", 0))
            by_objective[obj]["clicks"] += float(i.get("inline_link_clicks", 0))
            by_objective[obj]["reach"] += float(i.get("reach", 0))
            by_objective[obj]["campaigns"] += 1

        if not by_objective:
            return f"No Meta campaign data found for {date_range}."

        total_spend = sum(v["spend"] for v in by_objective.values())
        rows = []
        for obj, data in sorted(by_objective.items(), key=lambda x: -x[1]["spend"]):
            ctr = (data["clicks"] / data["impressions"] * 100) if data["impressions"] else 0
            pct_spend = (data["spend"] / total_spend * 100) if total_spend else 0
            note = "  ← historically best for Shibam" if obj == "OUTCOME_TRAFFIC" else ""
            rows.append({
                "Objective": obj + note,
                "Campaigns": str(data["campaigns"]),
                "Spend": fmt_currency(data["spend"]),
                "% of Total": fmt_pct(pct_spend, 1),
                "Impressions": fmt_number(data["impressions"]),
                "Clicks": fmt_number(data["clicks"]),
                "CTR": fmt_pct(ctr),
            })

        cols = ["Objective", "Campaigns", "Spend", "% of Total", "Impressions", "Clicks", "CTR"]
        return f"Meta Ads Objective Breakdown — {date_range}\n\n" + fmt_table(rows, cols)

    except Exception as e:
        logger.error("meta_ads_objective_breakdown failed: %s", e)
        return f"Error fetching Meta Ads objective breakdown: {e}"


@api_retry()
async def meta_ads_creative_performance(
    date_range: str = "last_7_days",
    start_date: str = "",
    end_date: str = "",
    campaign_id: str = "",
) -> str:
    """
    Fetch ad-level creative performance for all active Meta Ads.

    Returns ad name, impressions, link CTR, frequency, and spend, sorted by spend descending.

    Args:
        date_range:  last_7_days | last_30_days | this_month | last_month | custom
        start_date:  YYYY-MM-DD — required only when date_range=custom
        end_date:    YYYY-MM-DD — required only when date_range=custom
        campaign_id: optional — filter to a specific campaign ID
    """
    try:
        account = get_account()
        time_params = to_meta_time_range(date_range, start_date, end_date)

        ad_filter = [{"field": "ad.effective_status", "operator": "IN", "value": ["ACTIVE", "PAUSED"]}]
        if campaign_id:
            ad_filter.append({"field": "campaign.id", "operator": "EQUAL", "value": campaign_id})

        ads = account.get_ads(
            fields=["name", "creative", "status", "campaign_id"],
            params={"filtering": ad_filter},
        )

        rows = []
        for ad in ads:
            params = {**time_params, "level": "ad"}
            insights = list(ad.get_insights(
                fields=["ad_name", "impressions", "inline_link_click_ctr", "frequency", "spend"],
                params=params,
            ))
            if not insights:
                continue
            i = insights[0]
            rows.append({
                "Ad Name": i.get("ad_name", ad.get("name", ""))[:40],
                "Impressions": fmt_number(float(i.get("impressions", 0))),
                "Link CTR": fmt_pct(float(i.get("inline_link_click_ctr", 0))),
                "Frequency": f"{float(i.get('frequency', 0)):.2f}",
                "Spend": fmt_currency(float(i.get("spend", 0))),
                "_spend_raw": float(i.get("spend", 0)),
            })

        rows.sort(key=lambda x: -x["_spend_raw"])
        for r in rows:
            del r["_spend_raw"]

        if not rows:
            return f"No creative performance data found for {date_range}."

        cols = ["Ad Name", "Impressions", "Link CTR", "Frequency", "Spend"]
        return f"Meta Ads Creative Performance — {date_range}\n\n" + fmt_table(rows, cols)

    except Exception as e:
        logger.error("meta_ads_creative_performance failed: %s", e)
        return f"Error fetching Meta Ads creative performance: {e}"
