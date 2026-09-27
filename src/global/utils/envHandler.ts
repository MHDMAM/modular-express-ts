import config from 'config';

export default class EnvHandler {
  static getSSL(): boolean {
    const SSL = process.env.SSL;
    return SSL === 'true' || SSL === '1';
  }

  static getPort(): number {
    const envPort = process.env.PORT;
    const configPort = config.get('PORT');

    // Check if PORT is a valid string and try to parse it
    if (typeof envPort === 'string') {
      const parsedEnvPort = parseInt(envPort, 10);
      if (!isNaN(parsedEnvPort)) {
        return parsedEnvPort;
      }
    }

    // Check if config.get('PORT') is a number, or a string that can be parsed
    if (typeof configPort === 'number') {
      return configPort;
    } else if (typeof configPort === 'string') {
      const parsedConfigPort = parseInt(configPort, 10);
      if (!isNaN(parsedConfigPort)) {
        return parsedConfigPort;
      }
    }

    // Default value if neither PORT nor config.get('PORT') is valid
    return 3000;
  }
}
