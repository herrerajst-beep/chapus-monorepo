// Fuerza textos de permiso propios (en español) en Info.plist después de que los plugins
// de Expo escriban sus valores genéricos ("Allow $(PRODUCT_NAME)…"), motivo frecuente de
// rechazo en App Review (Guideline 5.1.1).
const { withInfoPlist } = require('expo/config-plugins');

module.exports = function withPurposeStrings(config, strings = {}) {
  return withInfoPlist(config, (cfg) => {
    Object.assign(cfg.modResults, strings);
    return cfg;
  });
};
