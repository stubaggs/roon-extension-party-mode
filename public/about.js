// Copyright (c) 2026 Stubaggs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * The About page's two Copy buttons: the details, as plain text ready to paste
 * into a forum post, and the Party Hub's address. Party Mode is usually opened over plain http, where browsers don't
 * offer navigator.clipboard, so it falls back to copying from a hidden text box.
 */
(function () {
  function fallback(value) {
    const box = document.createElement('textarea');
    box.value = value;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    let done = false;
    try {
      done = document.execCommand('copy');
    } catch (err) {
      done = false;
    }
    box.remove();
    return done;
  }

  /** Copies the value, then says(true) or says(false). */
  function copy(value, says) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(() => says(true), () => says(fallback(value)));
    } else {
      says(fallback(value));
    }
  }

  const details = document.querySelector('.details');
  const button = document.getElementById('copy-details');
  const status = document.getElementById('copied');
  if (details && button) {
    const text = () => {
      const lines = [details.dataset.title];
      details.querySelectorAll('section').forEach((section) => {
        lines.push('', section.querySelector('h2').textContent);
        section.querySelectorAll('tr').forEach((row) => {
          // innerText, so a value on two lines (<br>) copies on two lines.
          lines.push(`${row.cells[0].textContent}: ${row.cells[1].innerText}`);
        });
      });
      return lines.join('\n');
    };
    button.hidden = false;
    button.addEventListener('click', () => {
      copy(text(), (ok) => {
        status.textContent = ok ? 'Copied' : "Couldn't copy: select the details and copy them yourself";
      });
    });
  }

  const hub = document.getElementById('copy-hub');
  const hubStatus = document.getElementById('hub-copied');
  if (hub && hubStatus) {
    hub.hidden = false;
    hub.addEventListener('click', () => {
      copy(hub.dataset.url, (ok) => {
        hubStatus.textContent = ok ? 'Copied' : "Couldn't copy: select the address and copy it yourself";
      });
    });
  }
})();
