// Firebase (FCM) para los push de respaldo de Chapus Pro.
// - En EAS: GOOGLE_SERVICES_JSON es una variable de entorno secreta de tipo archivo; EAS
//   escribe el archivo en el builder y expone aquí su ruta.
// - En local: se usa ./google-services.json si existe (está en .gitignore).
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'google-services.json');
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON ?? (fs.existsSync(local) ? './google-services.json' : undefined);

  return {
    ...config,
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
  };
};
