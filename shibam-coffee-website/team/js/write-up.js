// /team/js/write-up.js
// Confidential employee corrective-action form for Leads and Management.

(function () {
  'use strict';

  var employees = [];
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

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    renderSessionBanner();
    setDefaultDates();
    bindForm();
    loadFormData();
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

  function setDefaultDates() {
    var value = today();
    document.getElementById('write-up-date').value = value;
    document.getElementById('employee-signature-date').value = value;
    document.getElementById('manager-signature-date').value = value;
    document.getElementById('follow-up-review-date').min = value;
  }

  function renderSessionBanner() {
    var mount = document.getElementById('session-banner');
    var session = Auth.getSession();
    if (!mount || !session) return;
    mount.textContent = 'Logged in as ';
    mount.appendChild(el('strong', null, session.name));
    mount.appendChild(document.createTextNode(' '));
    mount.appendChild(el('span', 'badge', session.role));
  }

  function setStatus(state, message) {
    var status = document.getElementById('write-up-status');
    status.textContent = message || '';
    if (state) status.setAttribute('data-state', state);
    else status.removeAttribute('data-state');
  }

  function loadFormData() {
    var history = document.getElementById('write-up-history-list');
    Auth.apiCall('getWriteUpFormData', {}).then(function (result) {
      if (!result.ok) {
        history.textContent = Auth.errorMessage(result, 'Could not load employee records.');
        return;
      }
      employees = Array.isArray(result.employees) ? result.employees : [];
      populateEmployees();
      var session = Auth.getSession();
      var eligibleEmployees = employees.filter(function (employee) { return !session || employee.id !== session.id; });
      document.getElementById('submit-write-up').disabled = !eligibleEmployees.length;
      if (!eligibleEmployees.length) setStatus('error', 'No other active employees are available. Management can add or reactivate employees from the Admin dashboard.');
      document.getElementById('write-up-supervisor').value = result.supervisor && result.supervisor.name || session && session.name || '';
      document.getElementById('manager-signature').value = result.supervisor && result.supervisor.name || session && session.name || '';
      document.getElementById('write-up-history-scope').textContent = result.historyScope === 'all'
        ? 'Management can review all submitted records.'
        : 'Leads can review records they personally submitted. Management can review all records.';
      renderHistory(Array.isArray(result.writeUps) ? result.writeUps : []);
    }).catch(function () {
      history.textContent = 'Could not load employee records. Check your connection and refresh.';
    });
  }

  function populateEmployees() {
    var select = document.getElementById('write-up-employee');
    var session = Auth.getSession();
    select.innerHTML = '';
    select.appendChild(new Option('Select an employee', ''));
    employees.forEach(function (employee) {
      if (session && employee.id === session.id) return;
      var label = employee.displayName && employee.displayName !== employee.name
        ? employee.displayName + ' (' + employee.name + ')'
        : employee.name;
      select.appendChild(new Option(label + ' — ' + employee.position, employee.id));
    });
  }

  function bindForm() {
    var form = document.getElementById('write-up-form');
    var employeeSelect = document.getElementById('write-up-employee');
    var writeUpDate = document.getElementById('write-up-date');
    var otherCheck = document.getElementById('infraction-other');
    var otherWrap = document.getElementById('other-infraction-wrap');
    var otherInput = document.getElementById('other-infraction');
    var declined = document.getElementById('employee-declined');
    var employeeSignature = document.getElementById('employee-signature');
    var employeeSignatureDate = document.getElementById('employee-signature-date');
    var witnessName = document.getElementById('witness-name');
    var witnessDate = document.getElementById('witness-date');

    employeeSelect.addEventListener('change', function () {
      var employee = employees.find(function (item) { return item.id === employeeSelect.value; });
      document.getElementById('write-up-position').value = employee ? employee.position : '';
      if (employee && !declined.checked) employeeSignature.placeholder = employee.name;
    });

    writeUpDate.addEventListener('change', function () {
      document.getElementById('follow-up-review-date').min = writeUpDate.value;
    });

    otherCheck.addEventListener('change', function () {
      otherWrap.hidden = !otherCheck.checked;
      otherInput.required = otherCheck.checked;
      if (!otherCheck.checked) otherInput.value = '';
    });

    declined.addEventListener('change', function () {
      employeeSignature.disabled = declined.checked;
      employeeSignature.required = !declined.checked;
      employeeSignatureDate.disabled = declined.checked;
      employeeSignatureDate.required = !declined.checked;
      if (declined.checked) {
        employeeSignature.value = '';
        employeeSignatureDate.value = '';
      } else {
        employeeSignatureDate.value = today();
      }
    });

    witnessName.addEventListener('input', function () {
      witnessDate.required = Boolean(witnessName.value.trim());
    });
    witnessDate.addEventListener('change', function () {
      witnessName.required = Boolean(witnessDate.value);
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var selectedInfractions = Array.from(form.querySelectorAll('[name="infractions"]:checked')).map(function (input) {
        return input.value;
      });
      if (!selectedInfractions.length) {
        setStatus('error', 'Select at least one type of infraction.');
        form.querySelector('[name="infractions"]').focus();
        return;
      }
      if (!form.reportValidity()) return;

      var button = document.getElementById('submit-write-up');
      button.disabled = true;
      setStatus(null, 'Submitting confidential record…');
      Auth.apiCall('submitWriteUp', {
        writeUp: {
          employeeId: form.employeeId.value,
          writeUpDate: form.writeUpDate.value,
          warningLevel: form.warningLevel.value,
          infractions: selectedInfractions,
          otherInfraction: form.otherInfraction.value,
          incidentDescription: form.incidentDescription.value,
          correctiveActionPlan: form.correctiveActionPlan.value,
          followUpReviewDate: form.followUpReviewDate.value,
          employeeComments: form.employeeComments.value,
          employeeDeclinedToSign: form.employeeDeclinedToSign.checked,
          employeeSignature: form.employeeSignature.value,
          employeeSignatureDate: form.employeeSignatureDate.value,
          managerSignature: form.managerSignature.value,
          managerSignatureDate: form.managerSignatureDate.value,
          witnessName: form.witnessName.value,
          witnessDate: form.witnessDate.value
        }
      }).then(function (result) {
        button.disabled = false;
        if (!result.ok) {
          setStatus('error', Auth.errorMessage(result, 'Could not submit this write-up. Review the form and try again.'));
          return;
        }
        form.reset();
        document.getElementById('write-up-position').value = '';
        otherWrap.hidden = true;
        otherInput.required = false;
        employeeSignature.disabled = false;
        employeeSignature.required = true;
        employeeSignatureDate.disabled = false;
        employeeSignatureDate.required = true;
        witnessName.required = false;
        witnessDate.required = false;
        setDefaultDates();
        var session = Auth.getSession();
        document.getElementById('write-up-supervisor').value = session ? session.name : '';
        document.getElementById('manager-signature').value = session ? session.name : '';
        setStatus('success', 'Write-up submitted and saved to the employee record.');
        loadFormData();
        document.getElementById('new-write-up-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }).catch(function () {
        button.disabled = false;
        setStatus('error', 'Could not reach the server. Check your connection and try again.');
      });
    });
  }

  function formatDate(value) {
    if (!value) return 'Not set';
    var parts = value.slice(0, 10).split('-');
    return parts.length === 3 ? parts[1] + '/' + parts[2] + '/' + parts[0] : value;
  }

  function detail(label, value, wide) {
    var wrap = el('div', wide ? 'write-up-record__detail write-up-record__detail--wide' : 'write-up-record__detail');
    wrap.appendChild(el('dt', null, label));
    wrap.appendChild(el('dd', null, value || 'Not provided'));
    return wrap;
  }

  function renderHistory(writeUps) {
    var mount = document.getElementById('write-up-history-list');
    mount.innerHTML = '';
    if (!writeUps.length) {
      mount.appendChild(el('p', 'document-card__placeholder', 'No write-ups are available in your history yet.'));
      return;
    }

    writeUps.forEach(function (record) {
      var card = el('details', 'write-up-record');
      var summary = el('summary', 'write-up-record__summary');
      var title = el('span', 'write-up-record__summary-main');
      title.appendChild(el('strong', null, record.employeeName));
      title.appendChild(el('small', null, formatDate(record.writeUpDate) + ' · ' + (LEVEL_LABELS[record.warningLevel] || record.warningLevel)));
      summary.appendChild(title);
      summary.appendChild(el('span', 'badge', record.warningLevel === 'verbal' ? 'Documented' : record.warningLevel.replace('_', ' ')));
      card.appendChild(summary);

      var body = el('div', 'write-up-record__body');
      var meta = el('dl', 'write-up-record__grid');
      meta.appendChild(detail('Employee', record.employeeName));
      meta.appendChild(detail('Position', record.employeePosition));
      meta.appendChild(detail('Supervisor', record.supervisorName));
      meta.appendChild(detail('Follow-up review', formatDate(record.followUpReviewDate)));
      meta.appendChild(detail('Infraction type(s)', (record.infractions || []).map(function (item) {
        return item === 'other' && record.otherInfraction ? 'Other: ' + record.otherInfraction : INFRACTION_LABELS[item] || item;
      }).join(', '), true));
      meta.appendChild(detail('Incident description', record.incidentDescription, true));
      meta.appendChild(detail('Corrective action plan', record.correctiveActionPlan, true));
      meta.appendChild(detail('Employee comments', record.employeeComments || 'None', true));
      meta.appendChild(detail('Employee acknowledgment', record.employeeDeclinedToSign
        ? 'Employee declined to sign'
        : record.employeeSignature + ' — ' + formatDate(record.employeeSignatureDate), true));
      meta.appendChild(detail('Lead / manager signature', record.managerSignature + ' — ' + formatDate(record.managerSignatureDate), true));
      if (record.witnessName) meta.appendChild(detail('Witness', record.witnessName + ' — ' + formatDate(record.witnessDate), true));
      meta.appendChild(detail('Submitted by', record.createdByName + ' on ' + new Date(record.createdAt).toLocaleString(), true));
      body.appendChild(meta);
      card.appendChild(body);
      mount.appendChild(card);
    });
  }
})();
