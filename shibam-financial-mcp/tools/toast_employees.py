"""Toast employee management — 4 tools wrapping the Labor API employees endpoints.

Implemented and ready to activate once Toast API production access is approved.
Until then, every tool returns the standard TOAST_API_PENDING message.
"""
import logging
import re
from typing import Optional
from clients import toast_client
from config import config
from utils.retry import api_retry

logger = logging.getLogger(__name__)

_PENDING_MSG = (
    "Toast API access is pending approval.\n"
    "Set TOAST_API_PENDING=false and add Toast credentials to enable these tools.\n"
    "Apply at: developers.toasttab.com"
)
_INVALID_NAME_CHARS = re.compile(r"[(){}<>$=\\;%]")


def _check_pending():
    return _PENDING_MSG if config.toast_api_pending else None


@api_retry()
async def toast_get_employees(modified_after: str = "", include_archived: bool = False) -> dict:
    """
    Fetch the current Toast employee roster.

    Args:
        modified_after:   YYYY-MM-DD — optional, filter to recently changed records
        include_archived: include soft-deleted/offboarded employees (default false)
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    try:
        all_employees, page_token = [], None
        while True:
            params = {"pageSize": 100}
            if page_token:
                params["pageToken"] = page_token
            if modified_after:
                params["modifiedDate"] = modified_after
            data = toast_client.get("/labor/v1/employees", params=params)
            page = data if isinstance(data, list) else data.get("employees", [])
            all_employees.extend(page)
            page_token = data.get("pageToken") if isinstance(data, dict) else None
            if not page_token or not page:
                break

        if not include_archived:
            all_employees = [e for e in all_employees if not e.get("deleted")]

        result = [{
            "guid": e.get("guid"),
            "firstName": e.get("firstName"),
            "lastName": e.get("lastName"),
            "email": e.get("email"),
            "jobs": e.get("jobReferences", []),
            "externalEmployeeId": e.get("externalEmployeeId"),
            "deleted": e.get("deleted", False),
        } for e in all_employees]

        return {"count": len(result), "employees": result}
    except Exception as e:
        logger.error("toast_get_employees failed: %s", e)
        return {"error": f"Error fetching Toast employees: {e}"}


def _validate_employee_fields(first_name: str = "", last_name: str = "", passcode: str = "") -> Optional[str]:
    if passcode and not (passcode.isdigit() and 1 <= len(passcode) <= 8):
        return "Invalid passcode — must be 1 to 8 numeric digits."
    for label, val in (("first_name", first_name), ("last_name", last_name)):
        if val and _INVALID_NAME_CHARS.search(val):
            return f"Invalid {label} — cannot contain ( ) {{ }} < > $ = \\ ; %"
    return None


@api_retry()
async def toast_create_employee(
    first_name: str,
    last_name: str,
    email: str,
    passcode: str,
    job_guid: str,
    hourly_wage: float = 0,
    external_id: str = "",
) -> dict:
    """
    Create a new Toast employee.

    Args:
        first_name:  required
        last_name:   required
        email:       required — unique per location, duplicate returns a Toast 400 error
        passcode:    required — 1 to 8 numeric digits; needed for POS clock-in
        job_guid:    required — GUID of the job/role to assign
        hourly_wage: optional — overrides the job's default wage
        external_id: optional — your internal employee ID
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    err = _validate_employee_fields(first_name, last_name, passcode)
    if err:
        return {"error": err}
    try:
        body = {
            "firstName": first_name,
            "lastName": last_name,
            "email": email,
            "passcode": passcode,
            "jobReferences": [{"guid": job_guid}],
        }
        if hourly_wage:
            body["wage"] = hourly_wage
        if external_id:
            body["externalEmployeeId"] = external_id

        result = toast_client.post("/labor/v1/employees", json=body)
        return {
            "employee": result,
            "note": "Employee can now log into Toast Web. To enable POS device login, confirm passcode was set.",
        }
    except Exception as e:
        logger.error("toast_create_employee failed: %s", e)
        return {"error": f"Error creating Toast employee: {e}"}


@api_retry()
async def toast_update_employee(
    employee_guid: str,
    first_name: str = "",
    last_name: str = "",
    email: str = "",
    passcode: str = "",
    job_guid: str = "",
    hourly_wage: float = 0,
    external_id: str = "",
    offboard: bool = False,
) -> dict:
    """
    Update an existing Toast employee, or offboard them (soft-delete).

    Args:
        employee_guid: required
        offboard:      if true, soft-deletes the employee after confirming they are clocked out
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    err = _validate_employee_fields(first_name, last_name, passcode)
    if err:
        return {"error": err}
    try:
        if offboard:
            entries = toast_client.get("/labor/v1/timeEntries", params={"employeeIds": employee_guid})
            entries = entries if isinstance(entries, list) else entries.get("timeEntries", [])
            still_clocked_in = any(e.get("inDate") and not e.get("outDate") for e in entries)
            if still_clocked_in:
                return {"error": "Cannot offboard — employee is currently clocked in. Clock them out first."}

        body = {}
        if first_name: body["firstName"] = first_name
        if last_name: body["lastName"] = last_name
        if email: body["email"] = email
        if passcode: body["passcode"] = passcode
        if job_guid: body["jobReferences"] = [{"guid": job_guid}]
        if hourly_wage: body["wage"] = hourly_wage
        if external_id: body["externalEmployeeId"] = external_id
        if offboard: body["deleted"] = True

        result = toast_client.patch(f"/labor/v1/employees/{employee_guid}", json=body)
        return {"employee": result} if not offboard else {"employee": result, "note": "Employee offboarded (soft-deleted)."}
    except Exception as e:
        logger.error("toast_update_employee failed: %s", e)
        return {"error": f"Error updating Toast employee: {e}"}


@api_retry()
async def toast_unarchive_employee(employee_guid: str) -> dict:
    """
    Restore a previously offboarded (soft-deleted) Toast employee.

    Args:
        employee_guid: required
    """
    pending = _check_pending()
    if pending:
        return {"error": pending}
    try:
        result = toast_client.post(f"/labor/v1/employees/{employee_guid}/unarchive")
        return {
            "employee": result,
            "note": (
                "Employee restored. Note: swipe card is NOT automatically re-associated — "
                "reset manually in Toast Web if needed. Previous job assignments have been restored."
            ),
        }
    except Exception as e:
        logger.error("toast_unarchive_employee failed: %s", e)
        return {"error": f"Error unarchiving Toast employee: {e}"}
