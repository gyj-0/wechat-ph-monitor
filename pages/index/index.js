/**
 * pH 监控首页逻辑（OneNET HTTP API 方案）
 *
 * 功能：
 *   1. 定时通过 OneNET 开放 API 查询设备最新属性（pH、OH）
 *   2. 显示实时 pH 和是否正在加液
 *   3. 一键发送手动加液 / 停止命令（ESP8266 优先执行手动命令，30 分钟后恢复自动）
 *
 * 说明：
 *   小程序通过 HTTPS 调用 OneNET 物联网套件 API，无需 MQTT 长连接。
 *   查询返回平台缓存的设备最近一次上报属性；
 *   下发命令由 OneNET 平台转发到 ESP8266 订阅的物模型 property/set topic。
 */

const secrets = require('../../utils/secrets.js')

Page({
  data: {
    isConnected: false,
    statusMsg: '',         // 未连接时显示的具体原因
    phValue: '--',
    isAdding: false,     // 设备上报：碱泵是否正在加液
    autoDosing: false,   // 本地按钮状态：最近一次下发的手动命令（OH=true/false）
    updateTime: '--:--:--'
  },

  // ==================== OneNET 配置 ====================
  // 设备 token / 产品 ID / 设备名在 utils/secrets.js 中（已被 .gitignore 排除不上传），
  // 首次使用复制 utils/secrets.example.js 为 utils/secrets.js 并填写
  config: {
    authorization: secrets.authorization,
    product_id: secrets.product_id,
    device_name: secrets.device_name,
    getinfo_url: 'https://iot-api.heclouds.com/thingmodel/query-device-property?product_id=' +
                 secrets.product_id + '&device_name=' + secrets.device_name,
    setinfo_url: 'https://iot-api.heclouds.com/thingmodel/set-device-property'
  },

  timer: null,
  POLL_INTERVAL: 3000,   // 查询间隔(ms)，与 ESP8266 上报周期一致

  onLoad() {
    this.Onenet_GetInfo()
    this.timer = setInterval(() => this.Onenet_GetInfo(), this.POLL_INTERVAL)
  },

  onUnload() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  },

  // ==================== 查询设备最新属性 ====================
  Onenet_GetInfo() {
    wx.request({
      url: this.config.getinfo_url,
      header: {
        'authorization': this.config.authorization
      },
      method: 'GET',
      success: (res) => {
        if (res.statusCode !== 200 || !res.data || res.data.code !== 0) {
          console.warn('[OneNET] 查询失败：', res.data)
          const msg = (res.data && (res.data.msg || res.data.error)) || ('HTTP ' + res.statusCode)
          this.setData({ isConnected: false, statusMsg: msg })
          return
        }

        // 响应格式：{ code: 0, data: [{identifier, value, time}, ...] }，value 为字符串
        const list = res.data.data || []
        const phItem = list.find(item => item.identifier === 'ph')
        const ohItem = list.find(item => item.identifier === 'OH')

        const now = new Date()
        const timeStr = [now.getHours(), now.getMinutes(), now.getSeconds()]
          .map(n => String(n).padStart(2, '0'))
          .join(':')

        const ph = phItem ? parseFloat(phItem.value) : NaN

        this.setData({
          isConnected: true,
          statusMsg: '',
          phValue: isNaN(ph) ? '--' : ph.toFixed(2),
          isAdding: ohItem ? (ohItem.value === true || ohItem.value === 'true') : false,
          updateTime: timeStr
        })
      },
      fail: (err) => {
        console.warn('[OneNET] 查询请求失败：', err)
        this.setData({ isConnected: false, statusMsg: err.errMsg || '网络请求失败' })
      }
    })
  },

  // ==================== 发送手动加液 / 停止命令 ====================
  onToggleAdding() {
    const newState = !this.data.autoDosing

    wx.request({
      url: this.config.setinfo_url,
      header: {
        'authorization': this.config.authorization
      },
      method: 'POST',
      data: {
        product_id: this.config.product_id,
        device_name: this.config.device_name,
        params: {
          OH: newState
        }
      },
      success: (res) => {
        if (res.data && res.data.code === 0) {
          this.setData({ autoDosing: newState })
          wx.showToast({
            title: newState ? '已发送手动开泵命令' : '已发送手动关泵命令',
            icon: 'none'
          })
        } else {
          console.warn('[OneNET] 下发失败：', res.data)
          const msg = (res.data && (res.data.msg || res.data.error)) || ('HTTP ' + res.statusCode)
          wx.showToast({
            title: '下发失败: ' + msg,
            icon: 'none',
            duration: 3000
          })
        }
      },
      fail: (err) => {
        console.warn('[OneNET] 下发请求失败：', err)
        wx.showToast({
          title: '网络请求失败',
          icon: 'none'
        })
      }
    })
  }
})
