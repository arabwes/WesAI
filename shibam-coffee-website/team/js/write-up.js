// /team/js/write-up.js
// Private staged corrective-action workflow for employees, Leads, and Management.

(function () {
  'use strict';

  var employees = [];
  var managedWriteUps = [];
  var session = null;
  var INFRACTION_LABELS = {
    attendance_punctuality: 'Attendance / punctuality',
    performance_issues: 'Performance issues',
    customer_service: 'Customer service issue',
    failure_to_follow_procedures: 'Failure to follow procedures',
    policy_violation: 'Policy violation',
    insubordination: 'Insubordination',
    safety_violation: 'Safety violation',
    other: 'Other'
  };
  var LEVEL_LABELS = {
    verbal: 'Verbal warning',
    strike_1: 'Strike 1 — First written warning',
    strike_2: 'Strike 2 — Final written warning',
    strike_3: 'Strike 3 — Final review'
  };
  var STATUS_LABELS = { draft: 'Draft', sent: 'Awaiting employee', completed: 'Completed' };

  document.addEventListener('DOMContentLoaded', function () {
    session = Auth.getSession();
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    renderSessionBanner();
    if (session && Auth.hasRole(session, 'lead')) bindLeadForm();
    loadWorkspace();
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function today() {
    var date = new Date();
    var offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function formatDate(value) {
    if (!value) return 'Not set';
    var parts = String(value).slice(0, 10).split('-');
    return parts.length === 3 ? parts[1] + '/' + parts[2] + '/' + parts[0] : value;
  }

  function formatDateTime(value) {
    if (!value) return 'Not set';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  function renderSessionBanner() {
    var mount = document.getElementById('session-banner');
    if (!mount || !session) return;
    mount.textContent = 'Logged in as ';
    mount.appendChild(el('strong', null, session.name));
    mount.appendChild(document.createTextNode(' '));
    mount.appendChild(el('span', 'badge', session.role));
  }

  function setLeadStatus(state, message) {
    var status = document.getElementById('write-up-status');
    if (!status) return;
    status.textContent = message || '';
    if (state) status.setAttribute('data-state', state);
    else status.removeAttribute('data-state');
  }

  function loadWorkspace() {
    Auth.apiCall('getWriteUpWorkspace', {}).then(function (result) {
      if (!result.ok) {
        document.getElementById('employee-inbox-list').textContent = Auth.errorMessage(result, 'Could not load employee messages.');
        var historyError = document.getElementById('write-up-history-list');
        if (historyError) historyError.textContent = Auth.errorMessage(result, 'Could not load write-up records.');
        return;
      }

      renderInbox(Array.isArray(result.inbox) ? result.inbox : []);
      if (!session || !Auth.hasRole(session, 'lead')) return;

      employees = Array.isArray(result.employees) ? result.employees : [];
      managedWriteUps = Array.isArray(result.managedWriteUps) ? result.managedWriteUps : [];
      populateEmployees();
      var eligibleEmployees = employees.filter(function (employee) { return employee.id !== session.id; });
      document.getElementById('save-write-up-draft').disabled = !eligibleEmployees.length;
      if (!eligibleEmployees.length) setLeadStatus('error', 'No other active employees are available. Management can add or reactivate employees from the Admin dashboard.');
      document.getElementById('write-up-supervisor').value = result.supervisor && result.supervisor.name || session.name;
      if (!document.getElementById('manager-signature').value) document.getElementById('manager-signature').value = result.supervisor && result.supervisor.name || session.name;
      document.getElementById('write-up-history-scope').textContent = result.historyScope === 'all'
        ? 'Management can review all drafts, sent records, and employee responses.'
        : 'You can review drafts and records you created. Management can review all records.';
      renderManagedWriteUps(managedWriteUps);
    }).catch(function () {
      document.getElementById('employee-inbox-list').textContent = 'Could not reach the server. Check your connection and refresh.';
      var historyError = document.getElementById('write-up-history-list');
      if (historyError) historyError.textContent = 'Could not reach the server. Check your connection and refresh.';
    });
  }

  function populateEmployees() {
    var select = document.getElementById('write-up-employee');
    var currentValue = select.value;
    select.replaceChildren(new Option('Select an employee', ''));
    employees.forEach(function (employee) {
      if (employee.id === session.id) return;
      var label = employee.displayName && employee.displayName !== employee.name
        ? employee.displayName + ' (' + employee.name + ')'
        : employee.name;
      select.appendChild(new Option(label + ' — ' + employee.position, employee.id));
    });
    if (currentValue) select.value = currentValue;
  }

  function resetLeadForm() {
    var form = document.getElementById('write-up-form');
    form.reset();
    form.writeUpId.value = '';
    form.version.value = '';
    document.getElementById('write-up-position').value = '';
    document.getElementById('write-up-date').value = today();
    document.getElementById('manager-signature-date').value = today();
    document.getElementById('manager-signature').value = session ? session.name : '';
    document.getElementById('write-up-supervisor').value = session ? session.name : '';
    document.getElementById('follow-up-review-date').min = today();
    document.getElementById('other-infraction-wrap').hidden = true;
    document.getElementById('other-infraction').required = false;
    document.getElementById('witness-name').required = false;
    document.getElementById('witness-date').required = false;
    document.getElementById('save-write-up-draft').textContent = 'Save draft';
    document.getElementById('cancel-write-up-edit').hidden = true;
  }

  function bindLeadForm() {
    var form = document.getElementById('write-up-form');
    var employeeSelect = document.getElementById('write-up-employee');
    var writeUpDate = document.getElementById('write-up-date');
    var otherCheck = document.getElementById('infraction-other');
    var otherWrap = document.getElementById('other-infraction-wrap');
    var otherInput = document.getElementById('other-infraction');
    var witnessName = document.getElementById('witness-name');
    var witnessDate = document.getElementById('witness-date');

    resetLeadForm();
    employeeSelect.addEventListener('change', function () {
      var employee = employees.find(function (item) { return item.id === employeeSelect.value; });
      document.getElementById('write-up-position').value = employee ? employee.position : '';
    });
    writeUpDate.addEventListener('change', function () {
      document.getElementById('follow-up-review-date').min = writeUpDate.value;
    });
    otherCheck.addEventListener('change', function () {
      otherWrap.hidden = !otherCheck.checked;
      otherInput.required = otherCheck.checked;
      if (!otherCheck.checked) otherInput.value = '';
    });
    witnessName.addEventListener('input', function () { witnessDate.required = Boolean(witnessName.value.trim()); });
    witnessDate.addEventListener('change', function () { witnessName.required = Boolean(witnessDate.value); });
    document.getElementById('cancel-write-up-edit').addEventListener('click', function () {
      resetLeadForm();
      setLeadStatus(null, '');
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var selectedInfractions = Array.from(form.querySelectorAll('[name="infractions"]:checked')).map(function (input) { return input.value; });
      if (!selectedInfractions.length) {
        setLeadStatus('error', 'Select at least one type of infraction.');
        form.querySelector('[name="infractions"]').focus();
        return;
      }
      if (!form.reportValidity()) return;

      var button = document.getElementById('save-write-up-draft');
      button.disabled = true;
      setLeadStatus(null, 'Saving private draft…');
      Auth.apiCall('saveWriteUpDraft', {
        writeUp: {
          writeUpId: form.writeUpId.value,
          version: form.version.value ? Number(form.version.value) : undefined,
          employeeId: form.employeeId.value,
          writeUpDate: form.writeUpDate.value,
          warningLevel: form.warningLevel.value,
          infractions: selectedInfractions,
          otherInfraction: form.otherInfraction.value,
          incidentDescription: form.incidentDescription.value,
          correctiveActionPlan: form.correctiveActionPlan.value,
          followUpReviewDate: form.followUpReviewDate.value,
          managerSignature: form.managerSignature.value,
          managerSignatureDate: form.managerSignatureDate.value,
          witnessName: form.witnessName.value,
          witnessDate: form.witnessDate.value
        }
      }).then(function (result) {
        button.disabled = false;
        if (!result.ok) {
          setLeadStatus('error', Auth.errorMessage(result, 'Could not save this draft. Review the form and try again.'));
          return;
        }
        resetLeadForm();
        setLeadStatus('success', 'Draft saved. It remains private until you send it from the workspace below.');
        loadWorkspace();
      }).catch(function () {
        button.disabled = false;
        setLeadStatus('error', 'Could not reach the server. Check your connection and try again.');
      });
    });
  }

  function detail(label, value, wide) {
    var wrap = el('div', wide ? 'write-up-record__detail write-up-record__detail--wide' : 'write-up-record__detail');
    wrap.appendChild(el('dt', null, label));
    wrap.appendChild(el('dd', null, value || 'Not provided'));
    return wrap;
  }

  function infractionText(record) {
    return (record.infractions || []).map(function (item) {
      return item === 'other' && record.otherInfraction ? 'Other: ' + record.otherInfraction : INFRACTION_LABELS[item] || item;
    }).join(', ');
  }

  function recordDetails(record, includeEmployeeResponse) {
    var meta = el('dl', 'write-up-record__grid');
    meta.appendChild(detail('Employee', record.employeeName));
    meta.appendChild(detail('Position', record.employeePosition));
    meta.appendChild(detail('Supervisor', record.supervisorName));
    meta.appendChild(detail('Follow-up review', formatDate(record.followUpReviewDate)));
    meta.appendChild(detail('Infraction type(s)', infractionText(record), true));
    meta.appendChild(detail('Incident description', record.incidentDescription, true));
    meta.appendChild(detail('Corrective action plan', record.correctiveActionPlan, true));
    meta.appendChild(detail('Lead / manager signature', record.managerSignature + ' — ' + formatDate(record.managerSignatureDate), true));
    if (record.witnessName) meta.appendChild(detail('Witness', record.witnessName + ' — ' + formatDate(record.witnessDate), true));
    if (includeEmployeeResponse && record.workflowStatus === 'completed') {
      meta.appendChild(detail('Employee comments', record.employeeComments || 'None', true));
      meta.appendChild(detail('Employee acknowledgment', record.employeeDeclinedToSign
        ? 'Employee declined to sign'
        : record.employeeSignature + ' — ' + formatDate(record.employeeSignatureDate), true));
      meta.appendChild(detail('Employee completed', formatDateTime(record.employeeCompletedAt), true));
    }
    return meta;
  }

  function makeSummary(record) {
    var summary = el('summary', 'write-up-record__summary');
    var title = el('span', 'write-up-record__summary-main');
    title.appendChild(el('strong', null, record.employeeName));
    title.appendChild(el('small', null, formatDate(record.writeUpDate) + ' · ' + (LEVEL_LABELS[record.warningLevel] || record.warningLevel)));
    summary.appendChild(title);
    summary.appendChild(el('span', 'badge write-up-status-badge write-up-status-badge--' + record.workflowStatus, STATUS_LABELS[record.workflowStatus] || record.workflowStatus));
    return summary;
  }

  function renderInbox(records) {
    var mount = document.getElementById('employee-inbox-list');
    mount.replaceChildren();
    if (!records.length) {
      mount.appendChild(el('p', 'document-card__placeholder', 'You do not have any employee messages.'));
      return;
    }

    var selectedId = new URLSearchParams(window.location.search).get('id');
    records.forEach(function (record) {
      var card = el('details', 'write-up-record write-up-inbox-record');
      card.dataset.writeUpId = record.writeUpId;
      if (record.writeUpId === selectedId || record.workflowStatus === 'sent') card.open = true;
      card.appendChild(makeSummary(record));
      var body = el('div', 'write-up-record__body');
      body.appendChild(recordDetails(record, true));
      if (record.workflowStatus === 'sent') body.appendChild(buildEmployeeResponseForm(record));
      card.appendChild(body);
      mount.appendChild(card);
    });
  }

  function buildEmployeeResponseForm(record) {
    var form = el('form', 'portal-form write-up-response-form');
    form.dataset.writeUpId = record.writeUpId;
    var heading = el('div', 'write-up-response-form__heading');
    heading.appendChild(el('h3', null, 'Your response'));
    heading.appendChild(el('p', 'write-up-help', 'Add comments if you wish, then acknowledge that you reviewed the record. Signing does not necessarily mean you agree.'));
    form.appendChild(heading);

    var commentsGroup = el('div', 'form-group');
    var commentsLabel = el('label', null, 'Employee comments (optional)');
    var comments = el('textarea');
    comments.id = 'employee-comments-' + record.writeUpId;
    commentsLabel.htmlFor = comments.id;
    comments.name = 'employeeComments';
    comments.rows = 5;
    comments.maxLength = 5000;
    commentsGroup.appendChild(commentsLabel);
    commentsGroup.appendChild(comments);
    form.appendChild(commentsGroup);

    var declinedLabel = el('label', 'write-up-check write-up-declined');
    var declined = el('input');
    declined.type = 'checkbox';
    declined.name = 'employeeDeclinedToSign';
    declinedLabel.appendChild(declined);
    declinedLabel.appendChild(document.createTextNode(' I decline to sign'));
    form.appendChild(declinedLabel);

    var signatureGrid = el('div', 'form-grid form-grid--2');
    var signatureGroup = el('div', 'form-group');
    var signatureLabel = el('label', null, 'Typed signature');
    var signature = el('input');
    signature.id = 'employee-signature-' + record.writeUpId;
    signatureLabel.htmlFor = signature.id;
    signature.type = 'text';
    signature.name = 'employeeSignature';
    signature.maxLength = 160;
    signature.required = true;
    signature.autocomplete = 'name';
    signature.placeholder = session ? session.name : '';
    signatureGroup.appendChild(signatureLabel);
    signatureGroup.appendChild(signature);
    var dateGroup = el('div', 'form-group');
    var dateLabel = el('label', null, 'Signature date');
    var signatureDate = el('input');
    signatureDate.id = 'employee-signature-date-' + record.writeUpId;
    dateLabel.htmlFor = signatureDate.id;
    signatureDate.type = 'date';
    signatureDate.name = 'employeeSignatureDate';
    signatureDate.value = today();
    signatureDate.required = true;
    dateGroup.appendChild(dateLabel);
    dateGroup.appendChild(signatureDate);
    signatureGrid.appendChild(signatureGroup);
    signatureGrid.appendChild(dateGroup);
    form.appendChild(signatureGrid);

    declined.addEventListener('change', function () {
      signature.disabled = declined.checked;
      signature.required = !declined.checked;
      signatureDate.disabled = declined.checked;
      signatureDate.required = !declined.checked;
      if (declined.checked) {
        signature.value = '';
        signatureDate.value = '';
      } else {
        signatureDate.value = today();
      }
    });

    var attestation = el('label', 'write-up-check write-up-attestation');
    var attestationInput = el('input');
    attestationInput.type = 'checkbox';
    attestationInput.required = true;
    attestation.appendChild(attestationInput);
    attestation.appendChild(document.createTextNode(' I confirm that I reviewed this write-up and that this is my response.'));
    form.appendChild(attestation);

    var actions = el('div', 'form-actions write-up-form-actions');
    var button = el('button', 'btn btn-primary', 'Send response');
    button.type = 'submit';
    var status = el('p', 'form-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    actions.appendChild(button);
    actions.appendChild(status);
    form.appendChild(actions);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;
      button.disabled = true;
      status.textContent = 'Sending your response…';
      status.removeAttribute('data-state');
      Auth.apiCall('completeWriteUp', {
        writeUpId: record.writeUpId,
        version: record.version,
        response: {
          employeeComments: comments.value,
          employeeDeclinedToSign: declined.checked,
          employeeSignature: signature.value,
          employeeSignatureDate: signatureDate.value
        }
      }).then(function (result) {
        if (!result.ok) {
          button.disabled = false;
          status.setAttribute('data-state', 'error');
          status.textContent = Auth.errorMessage(result, 'Could not send your response. Refresh and try again.');
          return;
        }
        status.setAttribute('data-state', 'success');
        status.textContent = 'Response sent. The lead has been notified.';
        loadWorkspace();
      }).catch(function () {
        button.disabled = false;
        status.setAttribute('data-state', 'error');
        status.textContent = 'Could not reach the server. Check your connection and try again.';
      });
    });
    return form;
  }

  function renderManagedWriteUps(records) {
    var mount = document.getElementById('write-up-history-list');
    mount.replaceChildren();
    if (!records.length) {
      mount.appendChild(el('p', 'document-card__placeholder', 'No write-up drafts or records are available yet.'));
      return;
    }
    var selectedId = new URLSearchParams(window.location.search).get('id');
    records.forEach(function (record) {
      var card = el('details', 'write-up-record');
      card.dataset.writeUpId = record.writeUpId;
      if (record.writeUpId === selectedId) card.open = true;
      card.appendChild(makeSummary(record));
      var body = el('div', 'write-up-record__body');
      body.appendChild(recordDetails(record, true));
      var timeline = el('p', 'write-up-record__timeline');
      timeline.textContent = record.workflowStatus === 'draft'
        ? 'Saved ' + formatDateTime(record.updatedAt)
        : record.workflowStatus === 'sent'
          ? 'Sent to employee ' + formatDateTime(record.sentAt)
          : 'Employee completed ' + formatDateTime(record.employeeCompletedAt);
      body.appendChild(timeline);
      if (record.workflowStatus === 'draft') body.appendChild(buildDraftActions(record));
      card.appendChild(body);
      mount.appendChild(card);
    });
  }

  function buildDraftActions(record) {
    var actions = el('div', 'write-up-record__actions');
    var edit = el('button', 'btn btn-outline', 'Edit draft');
    edit.type = 'button';
    edit.addEventListener('click', function () { editDraft(record); });
    var send = el('button', 'btn btn-primary', 'Send to employee');
    send.type = 'button';
    send.addEventListener('click', function () { sendDraft(record, send); });
    actions.appendChild(edit);
    actions.appendChild(send);
    return actions;
  }

  function editDraft(record) {
    var form = document.getElementById('write-up-form');
    resetLeadForm();
    form.writeUpId.value = record.writeUpId;
    form.version.value = record.version;
    form.employeeId.value = record.employeeId;
    form.writeUpDate.value = record.writeUpDate;
    document.getElementById('follow-up-review-date').min = record.writeUpDate;
    form.warningLevel.value = record.warningLevel;
    form.otherInfraction.value = record.otherInfraction || '';
    form.incidentDescription.value = record.incidentDescription;
    form.correctiveActionPlan.value = record.correctiveActionPlan;
    form.followUpReviewDate.value = record.followUpReviewDate || '';
    form.managerSignature.value = record.managerSignature;
    form.managerSignatureDate.value = record.managerSignatureDate;
    form.witnessName.value = record.witnessName || '';
    form.witnessDate.value = record.witnessDate || '';
    (record.infractions || []).forEach(function (value) {
      var checkbox = form.querySelector('[name="infractions"][value="' + value + '"]');
      if (checkbox) checkbox.checked = true;
    });
    var employee = employees.find(function (item) { return item.id === record.employeeId; });
    document.getElementById('write-up-position').value = employee ? employee.position : record.employeePosition;
    var hasOther = (record.infractions || []).includes('other');
    document.getElementById('other-infraction-wrap').hidden = !hasOther;
    document.getElementById('other-infraction').required = hasOther;
    document.getElementById('witness-name').required = Boolean(record.witnessDate);
    document.getElementById('witness-date').required = Boolean(record.witnessName);
    document.getElementById('save-write-up-draft').textContent = 'Update draft';
    document.getElementById('cancel-write-up-edit').hidden = false;
    setLeadStatus(null, 'Editing a private draft. The employee still cannot see it.');
    document.getElementById('new-write-up-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function sendDraft(record, button) {
    if (!window.confirm('Send this write-up to ' + record.employeeName + '? You will not be able to edit it after sending.')) return;
    button.disabled = true;
    button.textContent = 'Sending…';
    Auth.apiCall('sendWriteUp', { writeUpId: record.writeUpId, version: record.version }).then(function (result) {
      if (!result.ok) {
        button.disabled = false;
        button.textContent = 'Send to employee';
        setLeadStatus('error', Auth.errorMessage(result, 'Could not send this write-up. Refresh and try again.'));
        return;
      }
      setLeadStatus('success', 'Write-up sent. The employee has been notified and can now respond.');
      loadWorkspace();
    }).catch(function () {
      button.disabled = false;
      button.textContent = 'Send to employee';
      setLeadStatus('error', 'Could not reach the server. Check your connection and try again.');
    });
  }
})();
