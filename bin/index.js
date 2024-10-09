#!/usr/local/bin/node

const fsPromises = require('fs/promises');
const path = require('path'); 
const os = require('os');
const axios = require('axios');
const express = require('express');
const ora = require('ora');
const { Command } = require('commander');
const { prompt, MultiSelect } = require('enquirer');
const open = require('open');
const chalk = require('chalk');
const net = require('net'); 

const program = new Command();
const app = express();
const tileServerUrl = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png';

const getZoomLevel = (zoom) => {
    switch (zoom) {
        case 'country':
            return 8;
        case 'region':
            return 10;
        case 'station':
            return 12;
        default:
            return 0;
    }
};

const latLonToTile = (lat, lon, zoom) => {
    const x = Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
    const y = Math.floor((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    return { x, y };
};

const formatETA = (seconds) => {
    if (seconds < 60) {
        return `${Math.round(seconds)} second(s)`;
    } else if (seconds < 3600) {
        return `${Math.floor(seconds / 60)} minute(s)`;
    } else {
        return `${Math.floor(seconds / 3600)} hour(s)`;
    }
};

const isPortTaken = (port) => {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(true)); 
        server.listen(port, () => {
            server.close(() => resolve(false)); 
        });
    });
};

program
    .version('0.2.0')
    .description(`
        ${chalk.bold('AtlasOTM')}
        An internal tool used to cache and serve map tiles.
        
        ${chalk.italic('This tool is restricted to internal usage only.')}
    `);

program
    .command('generate')
    .description('Caches map tiles')
    .requiredOption('--lat1 <latitude>', 'Top left latitude')
    .requiredOption('--long1 <longitude>', 'Top left longitude')
    .requiredOption('--lat2 <latitude>', 'Bottom right latitude')
    .requiredOption('--long2 <longitude>', 'Bottom right longitude')
    .option('-f, --fast', 'Skip the 5-second delay between tile requests')
    .option('-a, --analytics', 'Display networking and storage data during generation')
    .option('--cache-dir <directory>', 'Specify cache directory (default: ~/AtlasOSMTiles)', path.join(os.homedir(), 'AtlasOSMTiles'))
    .option('-ci, --ci', 'Run in continuous integration mode without prompts')
    .action(async (options) => {
        const lat1 = parseFloat(options.lat1);
        const long1 = parseFloat(options.long1);
        const lat2 = parseFloat(options.lat2);
        const long2 = parseFloat(options.long2);

        let cacheDir = options.cacheDir;
        if (!options.ci) {
            const cacheDirPrompt = await prompt({
                type: 'input',
                name: 'cacheDir',
                message: 'Enter cache directory for tiles (leave blank for default):',
                initial: options.cacheDir,
            });
            cacheDir = cacheDirPrompt.cacheDir || options.cacheDir;
        }

        const zoomLevelsPrompt = new MultiSelect({
            name: 'zoomLevels',
            message: 'Select zoom levels to generate:',
            choices: ['country', 'region', 'station'],
        });

        const selectedZoomLevels = options.ci ? ['country', 'region', 'station'] : await zoomLevelsPrompt.run();

        const spinner = ora('Finding coordinate data...').start();

        if (selectedZoomLevels.length === 0) {
            spinner.fail(chalk.red('No zoom levels selected. Exiting.'));
            return;
        }

        let totalTiles = 0;
        const zoomLevelMapping = {};
        let totalBytesTransferred = 0;
        let processedTiles = 0;
        const startTime = Date.now();

        selectedZoomLevels.forEach(level => {
            const zoomLevel = getZoomLevel(level);
            zoomLevelMapping[level] = zoomLevel;

            const { x: xStart, y: yStart } = latLonToTile(lat1, long1, zoomLevel);
            const { x: xEnd, y: yEnd } = latLonToTile(lat2, long2, zoomLevel);

            totalTiles += (xEnd - xStart + 1) * (yEnd - yStart + 1);
        });

        if (totalTiles === 0) {
            spinner.fail(chalk.red('No tiles to generate. Exiting.'));
            return;
        }

        let isServerActive = false;

        process.on('SIGINT', async () => {
            spinner.stop(); 
            if (processedTiles === totalTiles && isServerActive) {
                const confirmPrompt = options.ci ? { confirm: true } : await prompt({
                    type: 'confirm',
                    name: 'confirm',
                    message: 'Exiting the server will terminate the process. Proceed?',
                    initial: false,
                });
                if (confirmPrompt.confirm) {
                    process.exit();
                } else {
                    console.log(chalk.yellow('Continuing, thank you!'));
                    spinner.start();
                }
            } else {
                const confirmPrompt = options.ci ? { confirm: true } : await prompt({
                    type: 'confirm',
                    name: 'confirm',
                    message: 'This will not remove any existing tiles that have been cached. Proceed?',
                    initial: false,
                });
                if (confirmPrompt.confirm) {
                    process.exit();
                } else {
                    console.log(chalk.yellow('Continuing, thank you!'));
                    spinner.start();
                }
            }
        });

        for (const level of selectedZoomLevels) {
            const zoomLevel = zoomLevelMapping[level];
            const { x: xStart, y: yStart } = latLonToTile(lat1, long1, zoomLevel);
            const { x: xEnd, y: yEnd } = latLonToTile(lat2, long2, zoomLevel);

            for (let x = xStart; x <= xEnd; x++) {
                for (let y = yStart; y <= yEnd; y++) {
                    const tileStartTime = Date.now();
                    const cacheFilePath = path.join(cacheDir, `${level}_${x}_${y}.png`);

                    try {
                        await fsPromises.mkdir(cacheDir, { recursive: true });
                        const url = tileServerUrl.replace('{z}', zoomLevel).replace('{x}', x).replace('{y}', y);
                        const response = await axios.get(url, { responseType: 'arraybuffer' });

                        totalBytesTransferred += response.data.byteLength;

                        await fsPromises.writeFile(cacheFilePath, response.data);
                    } catch (error) {
                        console.error(chalk.red(`Failed to fetch tile at ${x}, ${y}:`), error);
                        await fsPromises.appendFile('crash.log', `Failed to fetch tile at ${x}, ${y}: ${error}\n`);
                        spinner.fail(chalk.red(`Error processing tile at ${x}, ${y}. Exiting.`));
                        return;
                    }

                    processedTiles++;
                    const tileEndTime = Date.now();
                    const elapsedTime = (Date.now() - startTime) / 1000;
                    const eta = formatETA((elapsedTime / processedTiles) * (totalTiles - processedTiles));

                    if (options.analytics) {
                        const tilesPerSecond = (processedTiles / elapsedTime).toFixed(2);
                        spinner.text = `Processing tile ${processedTiles}/${totalTiles} (${eta}) - tiles/sec: ${tilesPerSecond} | total data: ${(totalBytesTransferred / (1024 * 1024)).toFixed(2)} MB`;
                    } else {
                        spinner.text = `Processing tile ${processedTiles}/${totalTiles} (${eta})`;
                    }

                    if (!options.fast) {
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }
        }

        const endTime = Date.now();
        const totalTime = ((endTime - startTime) / 1000).toFixed(2);
        spinner.succeed(chalk.green(`Completed tile generation! Processed ${processedTiles}/${totalTiles} tiles in ${totalTime} seconds.`));

        const launchServer = options.ci ? { confirm: false } : await prompt({
            type: 'confirm',
            name: 'confirm',
            message: 'Do you want to launch a server to preview changes?',
            initial: true,
        });

        let previewCacheDir = cacheDir;
        let previewPort = 3000; 
        if (launchServer.confirm) {
            const checkPort = async () => {
                while (await isPortTaken(previewPort)) {
                    console.log(chalk.yellow(`Port ${previewPort} is already in use. Trying next port...`));
                    previewPort++;
                }
                return previewPort;
            };

            previewPort = await checkPort();

            app.use('/cache', express.static(previewCacheDir));

            app.get('/', (req, res) => {
                res.sendFile(path.join(__dirname, 'index.html'));
            });

            app.listen(previewPort, (err) => {
                if (err) {
                    console.error(chalk.red(`Failed to start server on port ${previewPort}:`), err);
                    return;
                }
                console.log(chalk.green(`Server is running on http://localhost:${previewPort}`));
                open(`http://localhost:${previewPort}`);
                isServerActive = true;
            });
        }
    });

program
    .command('server')
    .description('Launches a tile server')
    .option('--port <port>', 'Specify port for the server (default: 3000)', '3000')
    .action(async (options) => {
        let port = parseInt(options.port, 10);

        const availablePort = await isPortTaken(port);
        if (availablePort) {
            console.log(chalk.yellow(`Port ${port} is in use. Finding available port...`));
            while (await isPortTaken(port)) {
                console.log(chalk.yellow(`Port ${port} is already in use. Trying next port...`));
                port++;
            }
        }

        app.use('/cache', express.static(path.join(os.homedir(), 'AtlasOSMTiles')));

        app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });

        app.listen(port, (err) => {
            if (err) {
                console.error(chalk.red(`Failed to start server on port ${port}:`), err);
                return;
            }
            console.log(chalk.green(`Tile server running on http://localhost:${port}`));
        });
    });

    program
    .command('coords')
    .description('Convert latitude/longitude to tile coordinates')
    .option('--lat <latitude>', 'Specify latitude (must be between -90 and 90)')
    .option('--long <longitude>', 'Specify longitude (must be between -180 and 180)')
    .option('-l, --level <zoom-level>', 'Specify zoom level (country, region, station; default: region)', 'region')
    .action(async (options) => {
        const { lat, long, level } = options;
        const zoomLevel = getZoomLevel(level);

        const latitude = parseFloat(lat);
        const longitude = parseFloat(long);

        const spinner = ora('Finding coordinates...').start();
        await new Promise(resolve => setTimeout(resolve, 500));

        if (isNaN(latitude) || latitude < -90 || latitude > 90) {
            spinner.fail(chalk.red('Invalid input: Latitude must be between -90 and 90.'));
            return;
        }

        if (isNaN(longitude) || longitude < -180 || longitude > 180) {
            spinner.fail(chalk.red('Invalid input: Longitude must be between -180 and 180.'));
            return;
        }

        if (zoomLevel === 0) {
            spinner.fail(chalk.red('Invalid zoom level: Must be country, region, or station.'));
            return;
        }

        const { x, y } = latLonToTile(latitude, longitude, zoomLevel);
        spinner.succeed(chalk.green(`Tile coordinates at zoom level ${level}: x=${x}, y=${y}`));
    });

program.parse(process.argv);
