#!/usr/local/bin/node

const fsPromises = require('fs/promises');
const path = require('path'); 
const os = require('os');
const axios = require('axios');
const express = require('express');
const ora = require('ora');
const { Command } = require('commander');
const { prompt } = require('enquirer');
const open = require('open');
const chalk = require('chalk');


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

program
    .version('0.1.0')
    .description(`
        ${chalk.bold('AtlasOTM')}
        An internal tool used to cache and serve map tiles.
        
        ${chalk.italic('This tool is restricted to internal usage only.')}
    `);
program
    .command('generate')
    .description('Caches map tiles')
    .option('-z, --zoom <level>', 'Optional zoom level (default: region)', 'region')
    .requiredOption('-a1, --lat1 <latitude>', 'Top left latitude')
    .requiredOption('-b1, --long1 <longitude>', 'Top left longitude')
    .requiredOption('-a1, --lat2 <latitude>', 'Bottom right latitude')
    .requiredOption('-b2, --long2 <longitude>', 'Bottom right longitude')
    .option('-f, --fast', 'Skip the 5-second delay between tile requests')
    .action(async (options) => {
        const spinner = ora('Finding coordinate data...').start();

        const lat1 = parseFloat(options.lat1);
        const long1 = parseFloat(options.long1);
        const lat2 = parseFloat(options.lat2);
        const long2 = parseFloat(options.long2);
        const zoomLevel = getZoomLevel(options.zoom);

        if (zoomLevel === 0) {
            spinner.fail(chalk.red('Invalid zoom level. Must be country, region, or station.'));
            return;
        }

        const { x: xStart, y: yStart } = latLonToTile(lat1, long1, zoomLevel);
        const { x: xEnd, y: yEnd } = latLonToTile(lat2, long2, zoomLevel);

        const totalTiles = (xEnd - xStart + 1) * (yEnd - yStart + 1);
        let processedTiles = 0;
        const startTime = Date.now();

        for (let x = xStart; x <= xEnd; x++) {
            for (let y = yStart; y <= yEnd; y++) {
                const tileStartTime = Date.now();
                const cacheDir = path.join(os.homedir(), 'AtlasOSMTiles', options.zoom);
                const cacheFilePath = path.join(cacheDir, `${options.zoom}_${x}_${y}.png`);

                try {
                    await fsPromises.mkdir(cacheDir, { recursive: true });
                    const url = tileServerUrl.replace('{z}', zoomLevel).replace('{x}', x).replace('{y}', y);
                    const response = await axios.get(url, { responseType: 'arraybuffer' });
                    await fsPromises.writeFile(cacheFilePath, response.data);
                } catch (error) {
                    console.error(chalk.red(`Failed to fetch tile at ${x}, ${y}:`), error);
                    await fsPromises.appendFile('crash.log', `Failed to fetch tile at ${x}, ${y}: ${error}\n`);
                    spinner.fail(chalk.red(`Error processing tile at ${x}, ${y}. Exiting.`));
                    return;
                }

                processedTiles++;
                const tileEndTime = Date.now();
                const timePerTile = ((tileEndTime - tileStartTime) / 1000).toFixed(2);
                const progress = ((processedTiles / totalTiles) * 100).toFixed(2);
                const elapsedTime = (Date.now() - startTime) / 1000;
                const eta = ((elapsedTime / processedTiles) * (totalTiles - processedTiles)).toFixed(2);
                spinner.text = `Processing tile ${processedTiles}/${totalTiles} (${progress}%) - Time per tile: ${timePerTile} seconds - ETA: ${eta} seconds`;

                if (!options.fast) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }

        const endTime = Date.now();
        const totalTime = ((endTime - startTime) / 1000).toFixed(2);
        spinner.succeed(chalk.green(`Completed tile generation! Processed ${processedTiles}/${totalTiles} tiles in ${totalTime} seconds.`));

        const launchServer = await prompt({
            type: 'confirm',
            name: 'confirm',
            message: 'Do you want to launch a server to preview changes?',
            initial: true,
        });

        if (launchServer.confirm) {
            const port = 3000;
            app.use('/cache', express.static(path.join(os.homedir(), 'AtlasOSMTiles')));

            app.get('/', (req, res) => {
                res.sendFile(path.join(__dirname, 'index.html'));
            });

            app.listen(port, () => {
                console.log(chalk.blue(`🌍 Server running at http://localhost:${port}/`));
                open(`http://localhost:${port}/`);
            });
        }
    });

program
    .command('server')
    .description('Run map frontend for previewing and serve cached files')
    .option('-p, --port <port>', 'Specify the server port (default: 3000)', 3000)
    .action((options) => {
        const cacheDir = path.join(os.homedir(), 'AtlasOSMTiles');
        app.use('/cache', express.static(cacheDir));

        app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });

        app.listen(options.port, () => {
            console.log(chalk.blue(`🌍 Server running at http://localhost:${options.port}/`));
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
