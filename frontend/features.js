(() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[character]));

  async function apiRequest(url, options = {}) {
    const token = sessionStorage.getItem('propertyflow-token');
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    let data;
    try {
      data = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text();
    } catch {
      throw new Error('The server returned an invalid response.');
    }
    if (!response.ok) throw new Error(typeof data === 'object' ? data.error || 'The request could not be completed.' : data);
    return data;
  }

  function showMessage(message) {
    window.showToast?.(message);
  }

  async function uploadFile(purpose, relatedId, file) {
    const parameter = purpose === 'request-photo' ? 'requestId' : 'leaseId';
    const query = new URLSearchParams({ purpose, [parameter]: relatedId, name: file.name });
    return apiRequest(`/api/files?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    });
  }

  window.uploadRequestFiles = async (requestId, files) => {
    for (const file of files) await uploadFile('request-photo', requestId, file);
  };

  window.openRequestPhotoUpload = requestId => {
    window.openModal('Add repair photos', '<p class="muted">Attach clear photos or a PDF relevant to this assigned repair.</p><label class="field">Photos or document (JPEG, PNG, WebP, PDF; max 10 MB each)<input name="file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple required></label><div class="form-error" id="modalError"></div><div class="modal-actions"><button type="button" class="secondary" onclick="closeModal()">Cancel</button><button class="primary">Upload files</button></div>', async form => {
      const files = form.getAll('file').filter(file => file instanceof File && file.size);
      if (!files.length) throw new Error('Choose at least one file.');
      await window.uploadRequestFiles(requestId, files);
      showMessage('Files attached to the maintenance request.');
    });
  };

  window.openLeaseDocumentUpload = leaseId => {
    window.openModal('Upload signed lease document', '<p class="muted">The file is kept private. The owner and the tenant on this lease can access it.</p><label class="field">Signed lease or related PDF (max 10 MB)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></label><div class="form-error" id="modalError"></div><div class="modal-actions"><button type="button" class="secondary" onclick="closeModal()">Cancel</button><button class="primary">Upload document</button></div>', async form => {
      const file = form.get('file');
      if (!(file instanceof File) || !file.size) throw new Error('Choose a document to upload.');
      await uploadFile('lease-document', leaseId, file);
      showMessage('Lease document stored securely.');
    });
  };

  window.downloadPrivateFile = async fileId => {
    const downloadWindow = window.open('about:blank', '_blank');
    if (!downloadWindow) {
      showMessage('Allow pop-ups to download this private file.');
      return;
    }
    try {
      const result = await apiRequest(`/api/files/${encodeURIComponent(fileId)}`);
      downloadWindow.opener = null;
      downloadWindow.location = result.downloadUrl;
    } catch (error) {
      downloadWindow.close();
      showMessage(error.message);
    }
  };

  async function printReceipt(paymentId) {
    const receiptWindow = window.open('', '_blank');
    if (!receiptWindow) {
      showMessage('Allow pop-ups to print the receipt.');
      return;
    }
    try {
      const { receipt } = await apiRequest(`/api/payments/${encodeURIComponent(paymentId)}/receipt`);
      const rows = [
        ['Receipt number', receipt.receiptNumber],
        ['Property', receipt.property],
        ['Tenant', receipt.tenant],
        ['Rent due date', receipt.dueDate],
        ['Paid at', receipt.paidAt ? new Date(receipt.paidAt).toLocaleString() : ''],
        ['Payment method', receipt.method],
        ['Transaction reference', receipt.reference],
        ['Amount received', `${receipt.currency} ${Number(receipt.amount).toLocaleString()}`]
      ];
      receiptWindow.document.write(`<!doctype html><html><head><title>Payment receipt</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:16px Arial,sans-serif;max-width:680px;margin:32px auto;padding:24px;color:#19352b}h1{margin-bottom:4px}p{color:#5d6e65}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{text-align:left;padding:12px;border-bottom:1px solid #dfe7e2}th{width:38%}button{padding:10px 18px}@media print{button{display:none}body{margin:0}}</style></head><body><h1>PropertyFlow payment receipt</h1><p>Payment confirmed</p><table>${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</table><button onclick="window.print()">Print / save as PDF</button></body></html>`);
      receiptWindow.document.close();
      receiptWindow.focus();
    } catch (error) {
      receiptWindow.close();
      showMessage(error.message);
    }
  }

  function paymentActions(payments) {
    return payments.map(payment => `<div class="request"><span class="dot ${payment.status === 'review' ? 'medium' : ''}"></span><div><div class="name">${escapeHtml(payment.amount)} KES · ${escapeHtml(payment.method)}</div><div class="detail">${escapeHtml(payment.reference || payment.receiptNumber || payment.id)} · Due ${escapeHtml(payment.dueDate)} · ${escapeHtml(payment.status)}</div></div><div class="quick-actions">${payment.status === 'review' ? `<button type="button" class="link-button" data-reconcile="confirm" data-payment="${escapeHtml(payment.id)}">Confirm</button><button type="button" class="link-button" data-reconcile="reject" data-payment="${escapeHtml(payment.id)}">Reject</button>` : ''}${payment.status === 'paid' ? `<button type="button" class="link-button" data-receipt="${escapeHtml(payment.id)}">Print receipt</button>` : ''}</div></div>`).join('') || '<div class="empty">No rent payments have been recorded.</div>';
  }

  function reportButtons() {
    return [
      ['rent', 'Rent collection'], ['arrears', 'Arrears'], ['occupancy', 'Occupancy'],
      ['maintenance', 'Maintenance'], ['lease-expiry', 'Lease expiry']
    ].map(([type, label]) => `<button type="button" class="secondary" data-report="${type}">${label} CSV</button>`).join('');
  }

  function featurePanels(data) {
    const sections = [];
    if (['owner', 'developer'].includes(data.role) && !data.readOnlyDeveloperView) {
      sections.push(`<div class="card" style="margin-top:20px"><div class="card-head"><div><h2>Reports and exports</h2><p class="card-subtitle">Download role-scoped CSV reports for rent, arrears, occupancy, maintenance, and lease expiry.</p></div></div><div class="quick-actions">${reportButtons()}</div></div>`);
      sections.push('<div class="card" style="margin-top:20px"><div class="card-head"><div><h2>Audit history</h2><p class="card-subtitle">Recent account, lease, rent, payment, document, and work-order changes.</p></div></div><div id="auditEntries" class="row-list"><div class="empty">Loading audit history…</div></div></div>');
    }
    if (data.role === 'owner' && !data.readOnlyDeveloperView) {
      const tenants = data.tenants || [];
      const leases = data.leases || [];
      const reviewPayments = (data.payments || []).filter(payment => payment.status === 'review');
      sections.push(`<div class="card" style="margin-top:20px"><div class="card-head"><div><h2>Payment reconciliation</h2><p class="card-subtitle">Record a bank or cash payment for review, then confirm it against your records.</p></div></div><form id="manualPaymentForm" class="stack"><label class="field">Tenant<select name="tenantId" required>${tenants.filter(tenant => tenant.status === 'active').map(tenant => `<option value="${escapeHtml(tenant.id)}">${escapeHtml(tenant.name)} · ${escapeHtml(tenant.unit)}</option>`).join('')}</select></label><label class="field">Amount (KES)<input name="amount" type="number" min="1" step="0.01" required></label><label class="field">Method<select name="method"><option value="bank">Bank transfer</option><option value="cash">Cash</option></select></label><label class="field">Transaction / cash reference<input name="reference" maxlength="100" required></label><label class="field">Rent due date<input name="dueDate" type="date"></label><button class="primary" ${tenants.length ? '' : 'disabled'}>Record for review</button><div class="form-error" id="paymentFormError"></div></form><h3>Review queue</h3><div class="row-list">${paymentActions(reviewPayments)}</div><h3>Confirmed receipts</h3><div class="row-list">${paymentActions((data.payments || []).filter(payment => payment.status === 'paid').slice(0, 20))}</div></div>`);
      sections.push(`<div class="card" style="margin-top:20px"><div class="card-head"><div><h2>Lease documents</h2><p class="card-subtitle">Private signed leases are accessible to the owner and the tenant named on the lease.</p></div></div><div class="row-list">${leases.map(lease => `<div class="request"><span class="dot"></span><div><div class="name">${escapeHtml(lease.tenantName)} · ${escapeHtml(lease.unitCode)}</div><div class="detail">Lease ends ${escapeHtml(lease.endDate || 'not set')}</div><div class="quick-actions">${(lease.attachments || []).map(file => `<button type="button" class="link-button" data-file="${escapeHtml(file.id)}">${escapeHtml(file.name)}</button>`).join('') || '<span class="detail">No documents uploaded</span>'}</div></div><button type="button" class="link-button" data-upload-lease="${escapeHtml(lease.id)}">Upload</button></div>`).join('') || '<div class="empty">No lease records yet.</div>'}</div></div>`);
      sections.push('<div class="card" style="margin-top:20px"><div class="card-head"><div><h2>Rent and lease reminders</h2><p class="card-subtitle">Default schedule: 3 days before rent, on the due date, and 3 and 7 days overdue; lease expiry at 30, 7, and 0 days.</p></div></div><form id="reminderSettingsForm" class="stack"><label class="field">Reminders<input name="enabled" type="checkbox" checked></label><label class="field">Rent reminder days from due date<input name="days" value="-3,0,3,7" required><span class="detail">Use comma-separated offsets: negative is before the due date.</span></label><label class="field">Lease expiry reminders (days before)<input name="leaseDays" value="30,7,0" required></label><button class="primary">Save reminder schedule</button><div class="form-error" id="reminderFormError"></div></form><div id="reminderHistory" class="row-list"></div></div>');
    }
    if (data.role === 'tenant' && data.lease) {
      sections.push(`<div class="card" style="margin-top:20px"><div class="card-head"><div><h2>Lease documents</h2><p class="card-subtitle">Documents shared with you by your property owner.</p></div></div><div class="row-list">${(data.lease.attachments || []).map(file => `<div class="request"><span class="dot"></span><div class="name">${escapeHtml(file.name)}</div><button type="button" class="link-button" data-file="${escapeHtml(file.id)}">Download</button></div>`).join('') || '<div class="empty">No lease documents have been shared yet.</div>'}</div></div>`);
    }
    if (data.role === 'tenant') {
      sections.push(`<div class="card" style="margin-top:20px"><div class="card-head"><div><h2>Payment receipts</h2><p class="card-subtitle">Print or save a PDF copy of confirmed rent receipts.</p></div></div><div class="row-list">${paymentActions((data.payments || []).filter(payment => payment.status === 'paid'))}</div></div>`);
    }
    return sections.join('');
  }

  function renderAudit(entries) {
    const target = document.getElementById('auditEntries');
    if (!target) return;
    target.innerHTML = entries.map(entry => {
      const details = Object.entries(entry.details || {}).filter(([key]) => !['ownerId', 'tenantId', 'propertyId', 'leaseId'].includes(key))
        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ');
      const timestamp = new Date(entry.createdAt);
      return `<div class="request"><span class="dot"></span><div><div class="name">${escapeHtml(entry.action.replaceAll('.', ' '))}</div><div class="detail">${escapeHtml(entry.actorName)} · ${escapeHtml(timestamp.toLocaleString())}${details ? ` · ${escapeHtml(details)}` : ''}</div></div></div>`;
    }).join('') || '<div class="empty">No changes have been recorded yet.</div>';
  }

  async function renderPropertyFeatures(data) {
    const root = document.getElementById('propertyFeatures');
    if (!root) return;
    root.innerHTML = featurePanels(data);
    if (['owner', 'developer'].includes(data.role) && !data.readOnlyDeveloperView) {
      try {
        const result = await apiRequest('/api/audit-logs?limit=50');
        renderAudit(result.auditLogs || []);
      } catch (error) {
        const target = document.getElementById('auditEntries');
        if (target) target.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
      }
    }
    if (data.role === 'owner') {
      const settingsForm = document.getElementById('reminderSettingsForm');
      if (settingsForm) {
        try {
          const result = await apiRequest('/api/reminder-settings');
          settingsForm.elements.enabled.checked = result.settings.enabled;
          settingsForm.elements.days.value = result.settings.days.join(',');
          settingsForm.elements.leaseDays.value = result.settings.leaseDays.join(',');
          const history = await apiRequest('/api/reminder-history');
          document.getElementById('reminderHistory').innerHTML = (history.history || []).slice(0, 10).map(entry => {
            const delivery = (entry.delivery || []).map(result => `Email ${result.email?.status || 'not sent'} · SMS ${result.sms?.status || 'not sent'}`).join(' / ');
            return `<div class="request"><span class="dot"></span><div><div class="name">${escapeHtml(entry.leaseId ? 'Lease expiry reminder' : 'Rent reminder')}</div><div class="detail">${escapeHtml(entry.createdAt)} · ${escapeHtml(delivery || 'No delivery record')}</div></div></div>`;
          }).join('');
        } catch (error) {
          document.getElementById('reminderFormError').textContent = error.message;
        }
      }
    }
  }

  window.renderPropertyFeatures = renderPropertyFeatures;
  window.openRequestModal = () => {
    window.openModal('Report an issue or idea', '<label class="field">Request type<select name="type"><option>Maintenance issue</option><option>Safety concern</option><option>Recommendation</option></select></label><label class="field">Short title<input name="title" required placeholder="e.g. Kitchen sink drain is blocked"></label><label class="field">Description<textarea name="details" required placeholder="Include details that will help the owner or agent respond."></textarea></label><label class="field">Priority<select name="priority"><option value="high">Urgent — needs quick attention</option><option value="medium">Important — not urgent</option><option value="normal">General request</option></select></label><label class="field">Repair photos or document (JPEG, PNG, WebP, PDF; max 10 MB each)<input name="attachments" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple></label><div class="form-error" id="modalError"></div><div class="modal-actions"><button type="button" class="secondary" onclick="closeModal()">Cancel</button><button class="primary">Send request</button></div>', async form => {
      const files = form.getAll('attachments').filter(file => file instanceof File && file.size);
      const body = Object.fromEntries([...form].filter(([key]) => key !== 'attachments'));
      const result = await apiRequest('/api/requests', { method: 'POST', body: JSON.stringify(body) });
      if (files.length) {
        try {
          await window.uploadRequestFiles(result.request.id, files);
        } catch (error) {
          showMessage(`Request sent, but a file could not be uploaded: ${error.message}`);
          return;
        }
      }
      showMessage('Request sent to your owner and agent.');
    });
  };

  document.addEventListener('click', async event => {
    const reportButton = event.target.closest('[data-report]');
    if (reportButton) {
      try {
        const token = sessionStorage.getItem('propertyflow-token');
        const response = await fetch(`/api/reports?type=${encodeURIComponent(reportButton.dataset.report)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (!response.ok) {
          let message = 'Report could not be downloaded.';
          try { message = (await response.json()).error || message; } catch {}
          throw new Error(message);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || `${reportButton.dataset.report}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        showMessage(error.message);
      }
      return;
    }
    const fileButton = event.target.closest('[data-file]');
    if (fileButton) return window.downloadPrivateFile(fileButton.dataset.file);
    const uploadButton = event.target.closest('[data-upload-lease]');
    if (uploadButton) return window.openLeaseDocumentUpload(uploadButton.dataset.uploadLease);
    const receiptButton = event.target.closest('[data-receipt]');
    if (receiptButton) return printReceipt(receiptButton.dataset.receipt);
    const reconcileButton = event.target.closest('[data-reconcile]');
    if (reconcileButton) {
      const reason = reconcileButton.dataset.reconcile === 'reject' ? window.prompt('Why could this payment not be confirmed?') : undefined;
      if (reconcileButton.dataset.reconcile === 'reject' && reason === null) return;
      try {
        await apiRequest(`/api/payments/${encodeURIComponent(reconcileButton.dataset.payment)}/reconcile`, {
          method: 'PATCH',
          body: JSON.stringify({ action: reconcileButton.dataset.reconcile, reason })
        });
        await window.loadDashboard();
        showMessage('Payment review updated.');
      } catch (error) {
        showMessage(error.message);
      }
    }
  });

  document.addEventListener('submit', async event => {
    if (event.target.id === 'manualPaymentForm') {
      event.preventDefault();
      const target = document.getElementById('paymentFormError');
      target.textContent = '';
      try {
        const values = Object.fromEntries(new FormData(event.target));
        await apiRequest('/api/payments/manual', { method: 'POST', body: JSON.stringify(values) });
        await window.loadDashboard();
        showMessage('Payment recorded for reconciliation.');
      } catch (error) {
        target.textContent = error.message;
      }
    }
    if (event.target.id === 'reminderSettingsForm') {
      event.preventDefault();
      const form = event.target;
      const target = document.getElementById('reminderFormError');
      target.textContent = '';
      const parseDays = value => value.split(',').map(item => item.trim()).filter(Boolean).map(Number);
      try {
        await apiRequest('/api/reminder-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            enabled: form.elements.enabled.checked,
            days: parseDays(form.elements.days.value),
            leaseDays: parseDays(form.elements.leaseDays.value)
          })
        });
        showMessage('Reminder schedule saved.');
      } catch (error) {
        target.textContent = error.message;
      }
    }
  });

  if (window.propertyFlowDashboard) renderPropertyFeatures(window.propertyFlowDashboard);
})();
