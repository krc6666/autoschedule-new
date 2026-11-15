// ==UserScript==
// @name         武汉天河机场国际航班筛选器
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  在 eoob.com.cn 上自动筛选国际航班
// @author       Kitty
// @match        https://www.eoob.com.cn/WUH/hangban-shike*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 创建浮动面板
    const panel = document.createElement('div');
    panel.id = 'flight-filter-panel';
    panel.innerHTML = `
        <div class="panel-header">
            <strong>国际航班筛选器</strong>
            <button id="toggle-panel">−</button>
        </div>
        <div class="panel-content">
            <p id="status-text">等待页面加载...</p>
            <button id="refresh-btn" style="display:none;">刷新筛选</button>
            <div id="flights-list"></div>
        </div>
    `;

    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
        #flight-filter-panel {
            position: fixed;
            top: 10px;
            right: 10px;
            width: 400px;
            max-height: 80vh;
            background: white;
            border: 2px solid #0078D4;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 10000;
            overflow: auto;
            font-family: 'Microsoft YaHei', Arial, sans-serif;
        }
        #flight-filter-panel .panel-header {
            background: #0078D4;
            color: white;
            padding: 10px 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-radius: 6px 6px 0 0;
            cursor: move;
        }
        #flight-filter-panel .panel-header button {
            background: white;
            color: #0078D4;
            border: none;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            cursor: pointer;
            font-weight: bold;
        }
        #flight-filter-panel .panel-content {
            padding: 15px;
        }
        #flight-filter-panel #status-text {
            color: #666;
            margin-bottom: 10px;
            font-size: 14px;
        }
        #flight-filter-panel #refresh-btn {
            background: #0078D4;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            margin-bottom: 10px;
        }
        #flight-filter-panel #refresh-btn:hover {
            background: #005a9e;
        }
        #flight-filter-panel .flight-item {
            padding: 10px;
            margin-bottom: 8px;
            background: #f5f5f5;
            border-radius: 4px;
            border-left: 3px solid #0078D4;
        }
        #flight-filter-panel .flight-item .flight-number {
            font-weight: bold;
            color: #0078D4;
        }
        #flight-filter-panel .flight-item .route {
            color: #333;
            margin: 5px 0;
        }
        #flight-filter-panel .flight-item .airline {
            color: #666;
            font-size: 12px;
        }
        #flight-filter-panel .flight-item .schedule {
            color: #666;
            font-size: 12px;
        }
        #flight-filter-panel .no-flights {
            color: #999;
            text-align: center;
            padding: 20px;
        }
        #flight-filter-panel .flight-count {
            background: #0078D4;
            color: white;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 12px;
            margin-left: 10px;
        }
        #flight-filter-panel .flight-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        #flight-filter-panel .flight-table th {
            background: #0078D4;
            color: white;
            padding: 8px;
            text-align: left;
        }
        #flight-filter-panel .flight-table td {
            padding: 8px;
            border-bottom: 1px solid #ddd;
        }
        #flight-filter-panel .flight-table tr:hover {
            background: #e8f4ff;
        }
        #flight-filter-panel .flight-table .flight-no {
            font-weight: bold;
            color: #0078D4;
        }
        #flight-filter-panel .flight-table .route {
            font-weight: 500;
        }
        #flight-filter-panel .flight-table .time {
            color: #666;
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    // 让面板可拖动
    let isDragging = false;
    let currentX, currentY, initialX, initialY;
    const header = panel.querySelector('.panel-header');

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        initialX = e.clientX - panel.offsetLeft;
        initialY = e.clientY - panel.offsetTop;
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            panel.style.left = currentX + 'px';
            panel.style.top = currentY + 'px';
            panel.style.right = 'auto';
        }
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });

    // 折叠/展开面板
    panel.querySelector('#toggle-panel').addEventListener('click', () => {
        const content = panel.querySelector('.panel-content');
        const btn = panel.querySelector('#toggle-panel');
        if (content.style.display === 'none') {
            content.style.display = 'block';
            btn.textContent = '−';
        } else {
            content.style.display = 'none';
            btn.textContent = '+';
        }
    });

    // 国际城市列表
    const internationalCities = [
        '首尔', '东京', '大阪', '新加坡', '曼谷', '吉隆坡', '悉尼', '墨尔本',
        '伦敦', '巴黎', '法兰克福', '阿姆斯特丹', '迪拜', '多哈', '莫斯科',
        '纽约', '洛杉矶', '旧金山', '温哥华', '多伦多', '莫斯科', '伊斯坦布尔',
        '香港', '澳门', '台北', '曼谷', '新加坡', '吉隆坡', '雅加达', '胡志明',
        '河内', '金边', '仰光', '马尼拉', '首尔', '釜山', '东京', '大阪', '名古屋',
        '福冈', '札幌', '冲绳', '悉尼', '墨尔本', '奥克兰', '温哥华', '多伦多',
        '伦敦', '巴黎', '法兰克福', '阿姆斯特丹', '罗马', '马德里', '巴塞罗那'
    ];

    // 判断是否为国际航班
    function isInternationalFlight(flightNumber, origin, destination) {
        // 中国主要航空公司代码（国内航班）
        const domesticAirlines = [
            'CA', 'MU', 'CZ', '3U', 'ZH', 'FM', 'HO', '9C', 'EU', 'OQ', 'GS',
            'NS', 'JD', 'TV', 'DR', 'G5', 'DZ', 'RY', 'AQ', 'QW', 'JR', 'KN',
            'BK', '8L', 'GT', 'GX', 'UQ', 'TV', 'GT'
        ];

        const flightPrefix = flightNumber.substring(0, 2);

        // 检查是否包含国际城市
        const hasInternationalCity = internationalCities.some(city =>
            destination.includes(city) || origin.includes(city)
        );

        // 检查是否为外国航空公司
        const isForeignAirline = !domesticAirlines.includes(flightPrefix);

        // 检查香港、澳门、台湾
        const hasHKMOTW = /香港|澳门|台北|台中|台南|高雄|桃园/.test(destination + origin);

        return hasInternationalCity || isForeignAirline || hasHKMOTW;
    }

    // 提取航班数据
    function extractFlightData() {
        const flights = [];

        // 方法1: 查找表格
        const tables = document.querySelectorAll('table');
        tables.forEach(table => {
            const rows = table.querySelectorAll('tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td, th');
                if (cells.length >= 4) {
                    const text = Array.from(cells).map(c => c.textContent.trim()).join(' ');
                    // 尝试提取航班号（格式：CA1234, MU5678等）
                    const flightMatch = text.match(/[A-Z]{2}\d{3,4}/);
                    if (flightMatch) {
                        const flightNumber = flightMatch[0];
                        const route = text;
                        flights.push({
                            number: flightNumber,
                            route: route,
                            fullText: text
                        });
                    }
                }
            });
        });

        // 方法2: 查找列表项
        const listItems = document.querySelectorAll('li, .flight-item, .flight-row, [class*="flight"], [class*="item"]');
        listItems.forEach(item => {
            const text = item.textContent.trim();
            const flightMatch = text.match(/[A-Z]{2}\d{3,4}/);
            if (flightMatch && !flights.find(f => f.number === flightMatch[0])) {
                flights.push({
                    number: flightMatch[0],
                    route: text,
                    fullText: text
                });
            }
        });

        // 方法3: 通用文本提取
        const allText = document.body.textContent;
        const flightMatches = allText.match(/[A-Z]{2}\d{3,4}/g) || [];
        flightMatches.forEach(match => {
            if (!flights.find(f => f.number === match)) {
                flights.push({
                    number: match,
                    route: match,
                    fullText: match
                });
            }
        });

        return [...new Set(flights.map(f => f.number))].map(number => ({
            number,
            route: flights.find(f => f.number === number)?.route || number,
            fullText: flights.find(f => f.number === number)?.fullText || number
        }));
    }

    // 筛选并显示国际航班
    function filterAndDisplay() {
        const statusText = document.getElementById('status-text');
        const flightsList = document.getElementById('flights-list');
        const refreshBtn = document.getElementById('refresh-btn');

        statusText.textContent = '正在分析页面...';
        refreshBtn.style.display = 'block';

        const allFlights = extractFlightData();
        const internationalFlights = allFlights.filter(f =>
            isInternationalFlight(f.number, '', f.route)
        );

        if (allFlights.length === 0) {
            statusText.textContent = '⚠️ 未找到航班数据，可能页面结构已变化';
            flightsList.innerHTML = '<div class="no-flights">建议刷新页面或联系开发者更新脚本</div>';
            return;
        }

        statusText.innerHTML = `找到 ${allFlights.length} 个航班，<span class="flight-count">${internationalFlights.length} 个国际航班</span>`;

        if (internationalFlights.length === 0) {
            flightsList.innerHTML = '<div class="no-flights">当前日期没有国际航班</div>';
            return;
        }

        // 显示国际航班表格
        let tableHTML = `
            <table class="flight-table">
                <thead>
                    <tr>
                        <th width="25%">航班号</th>
                        <th width="50%">航线信息</th>
                        <th width="25%">详情</th>
                    </tr>
                </thead>
                <tbody>
        `;

        internationalFlights.forEach(flight => {
            tableHTML += `
                <tr>
                    <td class="flight-no">${flight.number}</td>
                    <td class="route">${flight.route.substring(0, 50)}${flight.route.length > 50 ? '...' : ''}</td>
                    <td class="time">✓ 国际</td>
                </tr>
            `;
        });

        tableHTML += '</tbody></table>';
        flightsList.innerHTML = tableHTML;

        statusText.textContent = `✅ 筛选完成：${internationalFlights.length} 个国际航班`;
    }

    // 刷新按钮事件
    document.getElementById('refresh-btn').addEventListener('click', filterAndDisplay);

    // 等待页面加载完成后执行
    function init() {
        // 多次尝试，因为页面可能是动态加载的
        let attempts = 0;
        const maxAttempts = 5;
        const interval = setInterval(() => {
            attempts++;
            console.log(`航班筛选器：尝试 ${attempts}/${maxAttempts}`);

            if (document.body) {
                filterAndDisplay();
                clearInterval(interval);
            }

            if (attempts >= maxAttempts) {
                clearInterval(interval);
                document.getElementById('status-text').textContent = '⚠️ 页面加载超时，请点击刷新按钮';
            }
        }, 1000);
    }

    // 页面加载完成后启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('航班筛选器已启动');
})();