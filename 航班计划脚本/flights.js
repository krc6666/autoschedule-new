// 获取DOM元素
const dateInput = document.getElementById('date');
const loadBtn = document.getElementById('loadBtn');
const filterBtn = document.getElementById('filterBtn');
const statusDiv = document.getElementById('status');
const resultContainer = document.getElementById('resultContainer');
const flightsList = document.getElementById('flightsList');

// 设置默认日期为明天
function setDefaultDate() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateInput.value = tomorrow.toISOString().split('T')[0];
}

// 显示状态信息
function showStatus(message, type = 'info') {
    statusDiv.className = `status ${type}`;
    statusDiv.textContent = message;
    statusDiv.style.display = 'block';
}

// 加载航班计划
loadBtn.addEventListener('click', () => {
    const date = dateInput.value;
    if (!date) {
        showStatus('请先选择日期', 'error');
        return;
    }

    const url = `https://www.eoob.com.cn/WUH/hangban-shike#date=${date}`;
    window.open(url, '_blank');

    showStatus('已在新窗口打开航班计划网站。请等待数据加载完成后，复制所有航班数据（Ctrl+A, Ctrl+C），然后点击"筛选国际航班"按钮。', 'info');
});

// 筛选国际航班
filterBtn.addEventListener('click', async () => {
    try {
        // 尝试从剪贴板读取
        const clipboardText = await navigator.clipboard.readText();

        if (!clipboardText || clipboardText.trim().length === 0) {
            showStatus('剪贴板中没有数据。请先复制航班数据。', 'error');
            return;
        }

        showStatus('正在分析航班数据...', 'info');

        // 解析航班数据
        const flights = parseFlightData(clipboardText);

        if (flights.length === 0) {
            showStatus('未能识别航班数据。请确保复制的是完整的航班列表页面。', 'error');
            return;
        }

        // 筛选国际航班
        const internationalFlights = flights.filter(flight => {
            return isInternationalFlight(flight);
        });

        // 显示结果
        displayFlights(internationalFlights);

        if (internationalFlights.length === 0) {
            showStatus(`分析了 ${flights.length} 个航班，但没有找到国际航班。`, 'info');
        } else {
            showStatus(`成功！从 ${flights.length} 个航班中筛选出 ${internationalFlights.length} 个国际航班。`, 'success');
        }

        resultContainer.style.display = 'block';

    } catch (error) {
        console.error('读取剪贴板失败:', error);
        showStatus('无法读取剪贴板数据。请确保浏览器允许访问剪贴板，并手动粘贴数据。', 'error');

        // 尝试手动粘贴
        manualPaste();
    }
});

// 手动粘贴数据
function manualPaste() {
    const text = prompt('请粘贴航班数据：');
    if (text && text.trim()) {
        processPastedData(text);
    }
}

// 处理粘贴的数据
function processPastedData(text) {
    showStatus('正在分析航班数据...', 'info');

    const flights = parseFlightData(text);
    const internationalFlights = flights.filter(flight => isInternationalFlight(flight));

    displayFlights(internationalFlights);
    resultContainer.style.display = 'block';

    if (internationalFlights.length === 0) {
        showStatus(`分析了 ${flights.length} 个航班，但没有找到国际航班。`, 'info');
    } else {
        showStatus(`成功！从 ${flights.length} 个航班中筛选出 ${internationalFlights.length} 个国际航班。`, 'success');
    }
}

// 解析航班数据
function parseFlightData(text) {
    const flights = [];

    // 尝试多种模式匹配航班信息
    const patterns = [
        // 模式1: 航班号 航线 时间
        /([A-Z]{2}\d{3,4})\s+([^\s]+)\s*[-→]?\s*([^\s]+)\s+(\d{2}:\d{2})/g,
        // 模式2: 航班号 机场代码 时间
        /([A-Z]{2}\d{3,4})\s*[:：]?\s*([A-Z]{3})\s*[-→]?\s*([A-Z]{3})\s*(\d{2}:\d{2})/g,
        // 模式3: 中文航班信息
        /(\w+?\d{3,4})\s+(\S+)\s*[:：]?\s*(\S+)\s+(\d{1,2}:\d{2})/g
    ];

    // 提取航班行
    const lines = text.split('\n');

    lines.forEach(line => {
        if (line.trim().length < 5) return;

        for (const pattern of patterns) {
            const matches = line.match(pattern);
            if (matches) {
                flights.push({
                    raw: line.trim(),
                    flightNumber: matches[1] || '',
                    origin: matches[2] || '',
                    destination: matches[3] || '',
                    time: matches[4] || ''
                });
                break;
            }
        }
    });

    // 如果没有匹配到，尝试更宽松的匹配
    if (flights.length === 0) {
        lines.forEach(line => {
            if (line.trim().length > 10) {
                flights.push({
                    raw: line.trim(),
                    flightNumber: '未知',
                    origin: '未知',
                    destination: '未知',
                    time: '未知'
                });
            }
        });
    }

    return flights;
}

// 判断是否为国际航班
function isInternationalFlight(flight) {
    // 国际航班判断规则
    const internationalKeywords = [
        '国际', 'International', 'INTL', '国际/地区', '地区',
        'Tokyo', 'Seoul', 'Bangkok', 'Singapore', 'Hong Kong', 'Dubai',
        'London', 'Paris', 'Sydney', 'Los Angeles', 'New York'
    ];

    // 检查原始文本是否包含国际关键词
    const text = flight.raw.toLowerCase();
    const hasKeyword = internationalKeywords.some(keyword =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );

    // 检查起降机场是否为国际机场
    const internationalAirports = ['NRT', 'HND', 'ICN', 'BKK', 'SIN', 'HKG', 'DXB', 'LHR', 'CDG', 'SYD', 'LAX', 'JFK'];
    const isInternationalAirport =
        internationalAirports.includes(flight.origin) ||
        internationalAirports.includes(flight.destination);

    // 检查航班号是否为国际航空公司
    const internationalAirlines = ['CA', 'MU', 'CZ', 'JL', 'NH', 'OZ', 'KE', 'TG', 'SQ', 'CX', 'EK', 'QF'];
    const airlineCode = flight.flightNumber.substring(0, 2);
    const isInternationalAirline = internationalAirlines.includes(airlineCode);

    return hasKeyword || isInternationalAirport || isInternationalAirline;
}

// 显示航班列表
function displayFlights(flights) {
    flightsList.innerHTML = '';

    if (flights.length === 0) {
        flightsList.innerHTML = '<div class="no-flights">未找到符合条件的国际航班</div>';
        return;
    }

    flights.forEach((flight, index) => {
        const flightDiv = document.createElement('div');
        flightDiv.className = 'flight-item';
        flightDiv.innerHTML = `
            <div class="flight-header">
                <span class="flight-number">${flight.flightNumber}</span>
                <span class="type international">国际</span>
            </div>
            <div class="route">${flight.origin} → ${flight.destination}</div>
            <div class="time">起飞时间：${flight.time}</div>
            <div style="margin-top: 8px; color: #666; font-size: 12px;">${flight.raw}</div>
        `;
        flightsList.appendChild(flightDiv);
    });
}

// 初始化
setDefaultDate();