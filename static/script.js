document.addEventListener('DOMContentLoaded', () => {
            const refreshBtn = document.getElementById('refreshBtn');
            const pairsInput = document.getElementById('pairs');
            const intervalSelect = document.getElementById('interval');
            const atrSlider = document.getElementById('atr_period');
            const atrValue = document.getElementById('atr_value');
            const riskSlider = document.getElementById('risk_mult');
            const riskValue = document.getElementById('risk_value');
            const loadingDiv = document.getElementById('loading');
            const errorDiv = document.getElementById('errorMsg');
            const summaryDiv = document.getElementById('summary');
            const actionableDiv = document.getElementById('actionable');
            const chartsDiv = document.getElementById('charts');

            // Update slider labels
            atrSlider.addEventListener('input', () => { atrValue.textContent = atrSlider.value; });
            riskSlider.addEventListener('input', () => { riskValue.textContent = riskSlider.value; });

            function updateServerTime() {
                const now = new Date();
                document.getElementById('serverTime').innerHTML = `<i class="far fa-clock"></i> ${now.toLocaleString()}`;
            }
            updateServerTime();
            setInterval(updateServerTime, 1000);

            refreshBtn.addEventListener('click', async() => {
                        loadingDiv.classList.remove('hidden');
                        errorDiv.classList.add('hidden');
                        summaryDiv.innerHTML = '';
                        actionableDiv.innerHTML = '';
                        chartsDiv.innerHTML = '';

                        const payload = {
                            pairs: pairsInput.value,
                            interval: intervalSelect.value,
                            atr_period: parseInt(atrSlider.value),
                            risk_mult: parseFloat(riskSlider.value)
                        };

                        try {
                            const response = await fetch('/api/signals', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });
                            const results = await response.json();
                            loadingDiv.classList.add('hidden');

                            if (!results.length) {
                                errorDiv.textContent = 'No data returned. Check symbols or internet.';
                                errorDiv.classList.remove('hidden');
                                return;
                            }

                            const valid = results.filter(r => !r.error);
                            const errors = results.filter(r => r.error);
                            if (errors.length) {
                                errorDiv.innerHTML = `<i class="fas fa-exclamation-triangle"></i> ${errors.map(e => `${e.pair}: ${e.error}`).join('; ')}`;
                errorDiv.classList.remove('hidden');
            }

            renderSummary(valid);
            renderActionableCards(valid);  // new card style
            renderCharts(valid);
        } catch (err) {
            loadingDiv.classList.add('hidden');
            errorDiv.textContent = 'Network error: ' + err.message;
            errorDiv.classList.remove('hidden');
        }
    });

    function renderSummary(results) {
        if (!results.length) return;
        const title = document.createElement('h2');
        title.innerHTML = '<i class="fas fa-table-list"></i> Live Signal Watchlist';
        summaryDiv.appendChild(title);
        
        const table = document.createElement('table');
        table.className = 'signal-table';
        table.innerHTML = `
            <thead>
                <tr><th>Pair</th><th>Signal</th><th>Conf</th><th>Price</th><th>TP</th><th>SL</th><th>ATR</th><th>Action</th></tr>
            </thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');
        results.forEach(r => {
            const row = tbody.insertRow();
            row.insertCell(0).textContent = r.pair;
            const sigCell = row.insertCell(1);
            sigCell.innerHTML = `<span class="signal-${r.signal}">${r.signal}</span>`;
            row.insertCell(2).textContent = r.confidence;
            row.insertCell(3).textContent = r.price;
            row.insertCell(4).textContent = r.tp;
            row.insertCell(5).textContent = r.sl;
            row.insertCell(6).textContent = r.atr;
            const copyCell = row.insertCell(7);
            const copyBtn = document.createElement('button');
            copyBtn.textContent = '📋 Copy';
            copyBtn.className = 'copy-btn';
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                copyTradePlan(r);
            };
            copyCell.appendChild(copyBtn);
        });
        summaryDiv.appendChild(table);
    }

    function renderActionableCards(results) {
        const actionable = results.filter(r => r.signal !== 'HOLD');
        if (!actionable.length) {
            actionableDiv.innerHTML = '<div class="loading-card" style="text-align:center"><i class="fas fa-hourglass-half"></i> No actionable signals — waiting for setup</div>';
            return;
        }
        const title = document.createElement('h2');
        title.innerHTML = '<i class="fas fa-bullhorn"></i> Ready-to-Trade Ideas';
        actionableDiv.appendChild(title);

        actionable.forEach(r => {
            const card = document.createElement('div');
            card.className = `trade-card trade-card-${r.signal.toLowerCase()}`;
            card.innerHTML = `
                <div class="trade-info">
                    <div class="trade-pair">${r.pair}</div>
                    <div class="trade-signal">${r.signal} · confidence ${r.confidence}</div>
                </div>
                <div class="trade-levels">
                    📈 TP: ${r.tp} &nbsp;|&nbsp; 📉 SL: ${r.sl}
                </div>
                <div class="trade-actions">
                    <button class="copy-btn copy-plan-btn" data-pair="${r.pair}" data-price="${r.price}" data-tp="${r.tp}" data-sl="${r.sl}" data-signal="${r.signal}" data-atr="${r.atr}"><i class="far fa-copy"></i> Copy Plan</button>
                </div>
            `;
            actionableDiv.appendChild(card);
        });

        // Attach copy events for card buttons
        document.querySelectorAll('.copy-plan-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const data = btn.dataset;
                const tradeText = `${data.signal} ${data.pair} at ${data.price}\nTP: ${data.tp} (3:1 R:R)\nSL: ${data.sl}\nATR used: ${data.atr}`;
                navigator.clipboard.writeText(tradeText);
                btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                setTimeout(() => { btn.innerHTML = '<i class="far fa-copy"></i> Copy Plan'; }, 1500);
            });
        });
    }

    function copyTradePlan(r) {
        const text = `${r.signal} ${r.pair} at ${r.price}\nTP: ${r.tp} (3:1 R:R)\nSL: ${r.sl}\nATR used: ${r.atr}`;
        navigator.clipboard.writeText(text);
        // Optional: small toast – but we rely on button flash
    }

    function renderCharts(results) {
        if (!results.length) return;
        const title = document.createElement('h2');
        title.innerHTML = '<i class="fas fa-chart-line"></i> Price Action + Signal';
        chartsDiv.appendChild(title);

        results.forEach(r => {
            if (!r.chart || !r.chart.dates.length) return;
            const expander = document.createElement('div');
            expander.className = 'expandable';
            const header = document.createElement('div');
            header.className = 'expandable-header';
            header.innerHTML = `${r.pair} – ${r.signal} (${r.confidence}) <span><i class="fas fa-chevron-down"></i></span>`;
            header.onclick = () => {
                const content = expander.querySelector('.expandable-content');
                content.classList.toggle('show');
                const icon = header.querySelector('i');
                if (content.classList.contains('show')) icon.className = 'fas fa-chevron-up';
                else icon.className = 'fas fa-chevron-down';
            };
            const content = document.createElement('div');
            content.className = 'expandable-content';
            const chartDiv = document.createElement('div');
            chartDiv.className = 'chart-container';
            content.appendChild(chartDiv);
            expander.appendChild(header);
            expander.appendChild(content);
            chartsDiv.appendChild(expander);

            const trace = {
                x: r.chart.dates,
                y: r.chart.prices,
                mode: 'lines',
                name: r.pair,
                line: { color: '#3b82f6', width: 2 }
            };
            const layout = {
                title: '',
                paper_bgcolor: '#1a1f2b',
                plot_bgcolor: '#13161f',
                font: { color: '#edf2f7' },
                xaxis: { gridcolor: '#2a2f3c' },
                yaxis: { gridcolor: '#2a2f3c' },
                margin: { t: 20, l: 50, r: 30, b: 30 }
            };
            const data = [trace];
            if (r.chart.signal_point) {
                data.push({
                    x: [r.chart.signal_point.date],
                    y: [r.chart.signal_point.price],
                    mode: 'markers+text',
                    text: [r.chart.signal_point.signal],
                    textposition: 'top center',
                    marker: { size: 12, color: r.chart.signal_point.signal === 'BUY' ? '#10b981' : '#ef4444' },
                    name: 'Signal'
                });
            }
            Plotly.newPlot(chartDiv, data, layout, { responsive: true });
        });
    }
});