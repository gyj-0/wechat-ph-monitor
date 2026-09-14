/**
 * 数据记录页（OneNET 属性历史 API）
 *
 * 布局：
 *   1. pH 折线图（canvas 手绘，含 6.5/8.5 阈值虚线）
 *   2. 累计加液统计卡片
 *   3. 加液记录（默认折叠，展开为列表）
 *   4. pH 原始数据（默认折叠，展开为列表）
 *   5. 导出 CSV（生成文件后用微信打开，可转发到文件传输助手）
 *
 * 数据来源：
 *   - 实时累计：query-device-property（dose_count / dose_ml）
 *   - 历史：query-device-property-history，倒序分页，每页 100 条
 *   - 设备每 3 秒上报一次，100 条约覆盖最近 5 分钟，"加载更多"翻页看更早数据
 */

const secrets = require('../../utils/secrets.js')

Page({
  data: {
    errorMsg: '',
    doseCount: '--',
    doseMl: '--',
    phHistory: [],      // [{ t: ms数值, v: 数值, time: 'MM-DD HH:mm:ss', value: '7.56' }]（新->旧）
    doseEvents: [],     // [{ t: ms数值, time, count }]
    showPhList: false,  // pH 原始数据列表折叠状态
    showDoseList: false,
    phMore: true,
    doseMore: true,
    epochNote: ''       // 归零后提示"仅显示 xx 之后的数据"
  },

  config: {
    authorization: secrets.authorization,
    product_id: secrets.product_id,
    device_name: secrets.device_name,
    history_url: 'https://iot-api.heclouds.com/thingmodel/query-device-property-history',
    property_url: 'https://iot-api.heclouds.com/thingmodel/query-device-property',
    setinfo_url: 'https://iot-api.heclouds.com/thingmodel/set-device-property'
  },

  PAGE_SIZE: 100,
  phOffset: 0,
  doseOffset: 0,
  dosePrevOldest: null, // 上一页最旧一条的 dose_count 值（跨页边界比较用）
  mlOffset: 0,
  mlPrevOldest: null,   // 上一页最旧一条的 dose_ml 值
  doseSegments: [],     // 加液时段 [{start, end}]（毫秒时间戳，画曲线覆盖段用）
  resetEpoch: 0,        // 归零时刻：只显示该时刻之后的数据（平台历史删不掉，本地过滤）

  onLoad() {
    this.resetEpoch = Number(wx.getStorageSync('ph_reset_epoch')) || 0
    if (this.resetEpoch > 0) {
      this.setData({ epochNote: '仅显示 ' + this.fmtTime(this.resetEpoch) + ' 之后的数据' })
    }
    this.loadTotals()
    this.loadPhHistory()
    this.loadDoseEvents()
  },

  // 毫秒时间戳 -> 'MM-DD HH:mm:ss'
  fmtTime(ms) {
    const d = new Date(Number(ms))
    const p = n => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  },

  // 通用：拉一页属性历史（倒序，新->旧）
  // 注意：start_time 不能为 0（报 10418"起始时间为空"），且平台只允许查最近 30 天内，
  // 取 7 天窗口留足边界余量
  fetchHistory(identifier, offset) {
    return new Promise((resolve, reject) => {
      const end = Date.now()
      const start = end - 7 * 24 * 3600 * 1000
      wx.request({
        url: this.config.history_url +
             '?product_id=' + this.config.product_id +
             '&device_name=' + this.config.device_name +
             '&identifier=' + identifier +
             '&start_time=' + start + '&end_time=' + end +
             '&sort=2&offset=' + offset + '&limit=' + this.PAGE_SIZE,
        header: { 'authorization': this.config.authorization },
        method: 'GET',
        success: (res) => {
          // 返回结构是 data.list（文档示例有误），防御性取错
          const list = res.data && res.data.data && res.data.data.list
          if (res.statusCode === 200 && res.data && res.data.code === 0) {
            resolve(list || [])
          } else {
            reject((res.data && (res.data.msg || res.data.error)) || ('HTTP ' + res.statusCode))
          }
        },
        fail: (err) => reject(err.errMsg || '网络请求失败')
      })
    })
  },

  // 累计加液次数 / 加液量（实时属性）
  loadTotals() {
    wx.request({
      url: this.config.property_url +
           '?product_id=' + this.config.product_id +
           '&device_name=' + this.config.device_name,
      header: { 'authorization': this.config.authorization },
      method: 'GET',
      success: (res) => {
        if (res.statusCode !== 200 || !res.data || res.data.code !== 0) return
        const list = res.data.data || []
        const cnt = list.find(i => i.identifier === 'dose_count')
        const ml = list.find(i => i.identifier === 'dose_ml')
        this.setData({
          doseCount: cnt ? String(cnt.value) : '--',
          doseMl: ml ? String(ml.value) : '--'
        })
      }
    })
  },

  // pH 历史（分页）
  loadPhHistory() {
    this.fetchHistory('ph', this.phOffset).then(list => {
      const rows = list.map(i => ({
        t: Number(i.time),
        v: parseFloat(i.value),
        time: this.fmtTime(i.time),
        value: i.value
      })).filter(r => r.t >= this.resetEpoch)   // 归零时刻之前的数据不显示
      this.phOffset += list.length
      // 整页都比归零时刻旧 -> 后面没有可显示的数据了，停止翻页
      const hasNewer = list.length > 0 && Number(list[list.length - 1].time) >= this.resetEpoch
      this.setData({
        phHistory: this.data.phHistory.concat(rows),
        phMore: hasNewer && list.length >= this.PAGE_SIZE
      }, () => this.drawChart())
    }).catch(err => {
      this.setData({ errorMsg: 'pH 历史加载失败：' + err })
    })
  },

  // 加液点记录：dose_count 历史里筛数值跳变点
  loadDoseEvents() {
    this.fetchHistory('dose_count', this.doseOffset).then(list => {
      const events = []
      // list 倒序（新->旧）：相邻比较，值比更旧的一条大 = 该时刻发生了一次加液
      for (let i = 0; i < list.length; i++) {
        const cur = Number(list[i].value)
        const older = i + 1 < list.length ? Number(list[i + 1].value) : this.dosePrevOldest
        const t = Number(list[i].time)
        if (older !== null && cur > older && t >= this.resetEpoch) {
          events.push({ t, time: this.fmtTime(list[i].time), count: cur })
        }
      }
      if (list.length > 0) {
        this.dosePrevOldest = Number(list[list.length - 1].value)
      }
      this.doseOffset += list.length
      const hasNewer = list.length > 0 && Number(list[list.length - 1].time) >= this.resetEpoch
      this.setData({
        doseEvents: this.data.doseEvents.concat(events),
        doseMore: hasNewer && list.length >= this.PAGE_SIZE
      }, () => this.drawChart())
      this.loadDoseSegments()   // 同步翻 dose_ml 页，补齐曲线上的加液覆盖段
    }).catch(err => {
      this.setData({ errorMsg: '加液记录加载失败：' + err })
    })
  },

  // 加液时段：dose_ml 历史的每次跳变 = 一次加液，
  // 跳变时刻 ≈ 加液结束时刻，跳变量(ml) ÷ 1ml/s = 时长，反推出 [start, end]
  loadDoseSegments() {
    this.fetchHistory('dose_ml', this.mlOffset).then(list => {
      const segs = []
      for (let i = 0; i < list.length; i++) {
        const cur = Number(list[i].value)
        const older = i + 1 < list.length ? Number(list[i + 1].value) : this.mlPrevOldest
        const t = Number(list[i].time)
        if (older !== null && cur > older && t >= this.resetEpoch) {
          const end = t
          const start = end - (cur - older) * 1000   // 1 ml = 1 秒
          segs.push({ start, end })
        }
      }
      if (list.length > 0) {
        this.mlPrevOldest = Number(list[list.length - 1].value)
      }
      this.mlOffset += list.length
      this.doseSegments = this.doseSegments.concat(segs)
      this.drawChart()
    }).catch(() => {})   // 时段数据加载失败不影响其他模块
  },

  // ==================== 折叠开关 ====================
  onTogglePhList() {
    this.setData({ showPhList: !this.data.showPhList })
  },

  onToggleDoseList() {
    this.setData({ showDoseList: !this.data.showDoseList })
  },

  // ==================== 数据归零 ====================
  // 设备统计清零 + 本地记录归零时刻：此后曲线/列表/导出只显示归零后的新数据
  onResetStats() {
    wx.showModal({
      title: '数据归零',
      content: '清零累计加液统计，并不再显示此前的 pH 曲线和加液记录？',
      confirmText: '归零',
      confirmColor: '#fa5151',
      success: (r) => {
        if (!r.confirm) return
        wx.request({
          url: this.config.setinfo_url,
          header: { 'authorization': this.config.authorization },
          method: 'POST',
          data: {
            product_id: this.config.product_id,
            device_name: this.config.device_name,
            params: { reset: true }
          },
          success: (res) => {
            if (res.data && res.data.code === 0) {
              // 记录归零时刻并持久化，重新加载所有数据
              this.resetEpoch = Date.now()
              wx.setStorageSync('ph_reset_epoch', this.resetEpoch)
              this.setData({ epochNote: '仅显示 ' + this.fmtTime(this.resetEpoch) + ' 之后的数据' })
              this.phOffset = 0
              this.doseOffset = 0
              this.dosePrevOldest = null
              this.mlOffset = 0
              this.mlPrevOldest = null
              this.doseSegments = []
              this.setData({ phHistory: [], doseEvents: [], phMore: true, doseMore: true })
              this.loadPhHistory()
              this.loadDoseEvents()
              wx.showToast({ title: '已归零，开始新一轮记录', icon: 'none' })
              // 等设备下一轮上报后刷新累计显示（平台缓存有几秒延迟）
              setTimeout(() => this.loadTotals(), 5000)
            } else {
              const msg = (res.data && (res.data.msg || res.data.error)) || ('HTTP ' + res.statusCode)
              wx.showToast({ title: '归零失败: ' + msg, icon: 'none', duration: 3000 })
            }
          },
          fail: () => {
            wx.showToast({ title: '网络请求失败', icon: 'none' })
          }
        })
      }
    })
  },

  // ==================== pH 折线图（canvas 手绘，零依赖） ====================
  drawChart() {
    const rows = this.data.phHistory
    wx.createSelectorQuery().in(this).select('#phChart')
      .fields({ node: true, size: true }).exec(res => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        const ctx = canvas.getContext('2d')
        const winW = wx.getWindowInfo ? wx.getWindowInfo().windowWidth : 375
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2
        // 部分基础库 fields 不返回 size，用窗口宽按 rpx 换算兜底
        // （container 24rpx + card 32rpx 两侧内边距，chart 高 400rpx）
        const w = (res[0].size && res[0].size.width) || (winW - Math.round(112 * winW / 750))
        const h = (res[0].size && res[0].size.height) || Math.round(400 * winW / 750)
        canvas.width = w * dpr
        canvas.height = h * dpr
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, w, h)

        if (rows.length < 2) {
          ctx.fillStyle = '#999'
          ctx.font = '13px sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('数据不足，点下方"加载更多"', w / 2, h / 2)
          return
        }

        const pts = rows.slice().reverse()   // 转成时间正序（旧->新）

        // 值域：数据范围并上阈值线 6.5 / 8.5，再留 10% 边距
        let lo = Infinity, hi = -Infinity
        pts.forEach(p => { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v })
        lo = Math.min(lo, 6.5)
        hi = Math.max(hi, 8.5)
        const pad = Math.max(0.2, (hi - lo) * 0.1)
        lo -= pad
        hi += pad

        const L = 40, R = 8, T = 10, B = 26
        const X = i => L + (w - L - R) * i / (pts.length - 1)
        const Y = v => T + (h - T - B) * (1 - (v - lo) / (hi - lo))

        // 坐标轴
        ctx.strokeStyle = '#ddd'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(L, T)
        ctx.lineTo(L, h - B)
        ctx.lineTo(w - R, h - B)
        ctx.stroke()

        // Y 轴刻度（低 / 中 / 高）
        ctx.fillStyle = '#999'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'right'
        ;[lo, (lo + hi) / 2, hi].forEach(v => {
          ctx.fillText(v.toFixed(1), L - 4, Y(v) + 3)
        })

        // 阈值虚线 6.5 / 8.5（目标区间）
        ctx.strokeStyle = '#07c160'
        ctx.setLineDash([4, 4])
        ;[6.5, 8.5].forEach(v => {
          ctx.beginPath()
          ctx.moveTo(L, Y(v))
          ctx.lineTo(w - R, Y(v))
          ctx.stroke()
        })
        ctx.setLineDash([])

        // pH 折线
        ctx.strokeStyle = '#1989fa'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        pts.forEach((p, i) => {
          if (i === 0) ctx.moveTo(X(i), Y(p.v))
          else ctx.lineTo(X(i), Y(p.v))
        })
        ctx.stroke()

        // 加液时段：橙色加粗覆盖曲线（段内只有一个采样点时画圆点）
        const segs = this.doseSegments
        if (segs.length > 0) {
          const t0 = pts[0].t
          const t1 = pts[pts.length - 1].t
          ctx.strokeStyle = '#ff976a'
          ctx.fillStyle = '#ff976a'
          ctx.lineWidth = 3.5
          segs.forEach(sg => {
            if (sg.end < t0 || sg.start > t1) return
            // 收集段内的采样点
            const inner = []
            pts.forEach((p, i) => {
              if (p.t >= sg.start && p.t <= sg.end) inner.push(i)
            })
            if (inner.length >= 2) {
              ctx.beginPath()
              inner.forEach((i, k) => {
                if (k === 0) ctx.moveTo(X(i), Y(pts[i].v))
                else ctx.lineTo(X(i), Y(pts[i].v))
              })
              ctx.stroke()
            } else {
              // 段太短（如 1s 自动脉冲）没有足够采样点：在最近点画圆点
              const i = Math.max(0, Math.min(pts.length - 1,
                        Math.round((sg.start - t0) / (t1 - t0) * (pts.length - 1))))
              ctx.beginPath()
              ctx.arc(X(i), Y(pts[i].v), 3, 0, 2 * Math.PI)
              ctx.fill()
            }
          })
        }

        // X 轴首尾时间
        ctx.fillStyle = '#999'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(pts[0].time, L, h - 8)
        ctx.textAlign = 'right'
        ctx.fillText(pts[pts.length - 1].time, w - R, h - 8)
      })
  },

  // ==================== 导出 CSV ====================
  onExportCSV() {
    const rows = this.data.phHistory
    const events = this.data.doseEvents
    if (rows.length === 0 && events.length === 0) {
      wx.showToast({ title: '暂无数据可导出', icon: 'none' })
      return
    }

    const fmtFull = ms => {
      const d = new Date(Number(ms))
      const p = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    // ﻿ BOM 让 Excel 正确识别 UTF-8 中文；单表三列方便直接导 Excel 分析
    let csv = '﻿类型,时间,数值\n'
    rows.slice().reverse().forEach(r => { csv += `pH,${fmtFull(r.t)},${r.value}\n` })
    events.slice().reverse().forEach(e => { csv += `加液,${fmtFull(e.t)},第${e.count}次\n` })

    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    const fname = `ph_data_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`
    const fpath = `${wx.env.USER_DATA_PATH}/${fname}`

    try {
      const fs = wx.getFileSystemManager()
      fs.writeFileSync(fpath, csv, 'utf8')
      wx.openDocument({
        filePath: fpath,
        showMenu: true,   // 右上角菜单可转发到文件传输助手/收藏
        fail: () => {
          wx.setClipboardData({ data: csv })
          wx.showToast({ title: '已复制到剪贴板', icon: 'none' })
        }
      })
    } catch (e) {
      wx.setClipboardData({ data: csv })
      wx.showToast({ title: '已复制到剪贴板', icon: 'none' })
    }
  }
})
