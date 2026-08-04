# 微信小程序 - pH 水质监控

用于远程查看 ESP8266 pH 控制器上报的实时数据，并发送手动加液/停止命令。

## 功能

- 每 3 秒通过 OneNET 开放 API 查询设备最新属性（pH 值、加液状态）
- 一键发送手动开泵/关泵命令（ESP8266 优先执行，30 分钟后恢复自动）
- 纯 HTTP（`wx.request`）实现，无需 MQTT 库、无需构建 npm

## 工作原理

```
ESP8266  --(MQTT 上报 property/post)-->  OneNET 平台  <--(HTTP GET 查询)--  小程序
ESP8266  <--(MQTT 推送 property/set)--  OneNET 平台  <--(HTTP POST 下发)-  小程序
```

- ESP8266 通过 MQTT（`mqtt.heclouds.com:1883`）接入 OneNET，周期性上报 `ph` / `OH` 属性。
- 小程序通过 HTTPS 调用 OneNET 物联网套件 API（`iot-api.heclouds.com`）：
  - 查询：平台返回设备最近一次上报的属性缓存。
  - 下发：平台将命令转成物模型 `property/set` 消息推送给 ESP8266。
- 小程序不占用设备的 MQTT 连接，互不影响。

## 项目结构

```
wechat-ph-monitor/
├── app.js
├── app.json
├── app.wxss
├── sitemap.json
├── project.config.json
└── pages/
    └── index/
        ├── index.js     # 页面逻辑（HTTP 查询 + 下发）
        ├── index.json
        ├── index.wxml   # 页面结构
        └── index.wxss
```

## OneNET 配置

设备 token、产品 ID、设备名等敏感配置集中在 `utils/secrets.js` 中，**该文件已被 `.gitignore` 排除，不会上传到仓库**。

首次使用：复制 `utils/secrets.example.js` 为 `utils/secrets.js`，然后填写真实值：

```js
// utils/secrets.js
module.exports = {
  authorization: 'YOUR_DEVICE_TOKEN',  // OneNET 设备鉴权 token（控制台生成）
  product_id: 'YOUR_PRODUCT_ID',       // OneNET 产品 ID
  device_name: 'YOUR_DEVICE_NAME'      // OneNET 设备名称
}
```

请确保 OneNET 物模型中已定义：

- `ph`（浮点型）：pH 值
- `OH`（布尔型）：碱泵实际状态 / 是否正在加液（同时作为手动加液的控制开关）

**注意**：设备 token 有有效期，过期后需要在 OneNET 控制台重新生成，并同步更新本小程序的 `utils/secrets.js` 和 ESP8266 代码中的 `secrets.h`。

## 使用的 API

### 查询设备属性

```
GET https://iot-api.heclouds.com/thingmodel/query-device-property?product_id=YOUR_PRODUCT_ID&device_name=YOUR_DEVICE_NAME
Header: authorization: <设备 token>
```

响应（`value` 为字符串，需自行转换类型）：

```json
{
  "code": 0,
  "data": [
    { "identifier": "ph", "value": "7.42", "time": 1710000000000 },
    { "identifier": "OH", "value": "false", "time": 1710000000000 }
  ],
  "msg": "succ"
}
```

### 设置设备属性（下发命令）

```
POST https://iot-api.heclouds.com/thingmodel/set-device-property
Header: authorization: <设备 token>
Body:
{
  "product_id": "YOUR_PRODUCT_ID",
  "device_name": "YOUR_DEVICE_NAME",
  "params": { "OH": true }
}
```

`OH` 为手动命令，优先级高于 ESP8266 的自动 pH 控制；ESP8266 收到后进入手动模式，30 分钟内无新命令则自动恢复自动控制。

## 使用方式

1. 打开微信开发者工具，选择「导入项目」，选择本目录。
2. 小程序管理后台将 `https://iot-api.heclouds.com` 加入 **request 合法域名**；开发阶段也可在开发者工具勾选「不校验合法域名」。
3. 点击「编译」即可。真机运行要求合法域名已配置。

## 注意事项

- 查询的是平台缓存的设备最近一次上报值，数据延迟取决于 ESP8266 上报周期（默认 3 秒）和小程序轮询周期（3 秒）。
- 点击按钮后，「是否正在加液」以 ESP8266 下一次上报为准，会有数秒延迟，属正常现象。
