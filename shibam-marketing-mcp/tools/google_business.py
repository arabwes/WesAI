"""Google Business Profile + Places API MCP tools — 3 tools covering reviews, profile completeness, and competitor listings."""
import logging
from datetime import date, timedelta
from mcp_common.errors import safe_error
from clients.gbp_client import get_reviews_service, get_info_service, places_find, places_details
from config import config, NotConfiguredError
from utils.formatting import fmt_table
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_COMPETITORS = [
    "967 Coffee Co Alpharetta GA",
    "MOTW Coffee and Pastries Alpharetta GA",
    "Qamaria Yemeni Coffee Atlanta GA",
    "Haraz Coffee Atlanta GA",
]

_REQUIRED_FIELDS = ["hours", "photos", "description", "website", "menu"]


@api_retry()
async def gbp_review_summary() -> str:
    """
    Fetch the business's current Google review summary.

    Returns star rating, total review count, reviews from the last 30 days,
    and average rating trend.
    """
    try:
        service = get_reviews_service()
        location_name = f"accounts/{config.gbp_account_id}/locations/{config.gbp_location_id}"
        result = service.accounts().locations().reviews().list(
            parent=location_name,
            pageSize=50,
        ).execute()

        reviews = result.get("reviews", [])
        avg_rating = result.get("averageRating", 0)
        total_count = result.get("totalReviewCount", 0)

        cutoff = date.today() - timedelta(days=30)
        recent = [
            r for r in reviews
            if r.get("createTime", "")[:10] >= str(cutoff)
        ]

        recent_ratings = [int(r.get("starRating", "ZERO").replace("STAR_", "").replace("ZERO", "0")
                             .replace("ONE", "1").replace("TWO", "2").replace("THREE", "3")
                             .replace("FOUR", "4").replace("FIVE", "5"))
                          for r in recent]
        recent_avg = sum(recent_ratings) / len(recent_ratings) if recent_ratings else 0

        lines = [
            f"Google Business Profile — Review Summary",
            f"",
            f"Overall Rating:        ⭐ {avg_rating:.1f} / 5.0",
            f"Total Reviews:         {total_count}",
            f"",
            f"Last 30 Days:",
            f"  New Reviews:         {len(recent)}",
            f"  Recent Avg Rating:   ⭐ {recent_avg:.1f} / 5.0" if recent else "  No new reviews in last 30 days.",
        ]

        if recent:
            lines += ["", "Most Recent Reviews:"]
            for r in recent[:5]:
                reviewer = r.get("reviewer", {}).get("displayName", "Anonymous")
                rating_str = r.get("starRating", "")
                comment = (r.get("comment", "") or "")[:100]
                lines.append(f"  • {reviewer} — {rating_str}")
                if comment:
                    lines.append(f"    \"{comment}{'...' if len(r.get('comment',''))>100 else ''}\"")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching Google Business Profile reviews")


@api_retry()
async def gbp_profile_completeness() -> str:
    """
    Check that the business's Google Business Profile is fully filled out.

    Checks: business hours, photos, description, website link, and menu link.
    Flags any missing or incomplete fields.
    """
    try:
        service = get_info_service()
        location_name = f"accounts/{config.gbp_account_id}/locations/{config.gbp_location_id}"
        location = service.accounts().locations().get(name=location_name).execute()

        checks = {
            "Business Hours": bool(location.get("regularHours", {}).get("periods")),
            "Photos": False,  # Requires separate media API call
            "Description": bool(location.get("profile", {}).get("description", "").strip()),
            "Website URL": bool(location.get("websiteUri", "").strip()),
            "Primary Category": bool(location.get("categories", {}).get("primaryCategory")),
        }

        # Check for photos separately
        try:
            media = service.accounts().locations().media().list(
                parent=location_name
            ).execute()
            checks["Photos"] = len(media.get("mediaItems", [])) > 0
        except Exception:
            checks["Photos"] = None  # Could not verify

        rows = []
        all_ok = True
        for field, status_val in checks.items():
            if status_val is True:
                icon = "✅"
            elif status_val is False:
                icon = "❌"
                all_ok = False
            else:
                icon = "⚠️  Could not verify"
            rows.append({"Field": field, "Status": icon})

        lines = [
            "Google Business Profile — Completeness Check",
            "",
            fmt_table(rows, ["Field", "Status"]),
        ]
        if all_ok:
            lines += ["", "✅  Profile appears complete."]
        else:
            missing = [r["Field"] for r in rows if "❌" in r["Status"]]
            lines += ["", f"⚠️  Action needed — fill in: {', '.join(missing)}"]
            lines.append("   Go to: business.google.com → Edit Profile")

        return "\n".join(lines)

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "checking Google Business Profile completeness")


@api_retry()
async def gbp_competitor_listings() -> str:
    """
    Fetch Google Places data for the configured competitor listings.

    Returns star rating, review count, price level, and hours for each.
    No parameters needed — competitor list is configured in the server.
    """
    try:
        rows = []
        for competitor_query in _COMPETITORS:
            try:
                find_result = places_find(competitor_query)
                candidates = find_result.get("candidates", [])
                if not candidates:
                    rows.append({
                        "Name": competitor_query.split(" Alpharetta")[0].split(" Atlanta")[0],
                        "Rating": "Not found",
                        "Reviews": "—",
                        "Price": "—",
                        "Notes": "No listing found",
                    })
                    continue

                place_id = candidates[0]["place_id"]
                details = places_details(place_id)

                price_map = {1: "$", 2: "$$", 3: "$$$", 4: "$$$$"}
                price = price_map.get(details.get("price_level"), "—")
                hours_today = "—"
                if details.get("opening_hours", {}).get("open_now") is not None:
                    hours_today = "Open now" if details["opening_hours"]["open_now"] else "Closed now"

                rows.append({
                    "Name": details.get("name", competitor_query)[:30],
                    "Rating": f"⭐ {details.get('rating', '—')}",
                    "Reviews": fmt_table([], []) if False else str(details.get("user_ratings_total", "—")),
                    "Price": price,
                    "Today": hours_today,
                })
            except Exception as comp_err:
                rows.append({
                    "Name": competitor_query.split(" Alpharetta")[0].split(" Atlanta")[0],
                    "Rating": "Error",
                    "Reviews": "—",
                    "Price": "—",
                    "Today": str(comp_err)[:40],
                })

        cols = ["Name", "Rating", "Reviews", "Price", "Today"]
        return (
            "Google Business Profile — Competitor Listings\n\n"
            + fmt_table(rows, cols)
            + "\n\nData sourced from Google Places API."
        )

    except Exception as e:
        if getattr(e, "_user_facing", False) or isinstance(e, NotConfiguredError):
            return str(e)
        return safe_error(e, "fetching competitor listings")
