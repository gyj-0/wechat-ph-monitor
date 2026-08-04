/**
 * OneNET 设备鉴权配置（模板）
 *
 * 使用方法：复制本文件为 secrets.js（同一目录），并填入真实值。
 * secrets.js 已被 .gitignore 排除，不会上传到仓库。
 */

module.exports = {
  // 设备鉴权 token（OneNET 控制台生成）
  authorization: 'YOUR_DEVICE_TOKEN',
  product_id: 'YOUR_PRODUCT_ID',   // OneNET 产品 ID
  device_name: 'YOUR_DEVICE_NAME'  // OneNET 设备名称
}
