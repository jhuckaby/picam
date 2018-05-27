## Overview

**picam** is a simple camera system for the [Raspberry Pi](https://www.raspberrypi.org), which takes snapshots at custom intervals (daily, hourly, or every minute), and uploads them to your FTP server.  It is designed specifically for unstable network conditions, and will buffer images locally until they all can be uploaded successfully.  Images older than N days can be automatically deleted from the FTP server.  Finally, a web server is provided to take a snapshot and view the image via any web browser.

Tested on a Raspberry Pi 3 with [Raspbian OS](https://www.raspbian.org/) v8 and [Node.js](https://nodejs.org/en/) v0.10.

### Features

- Snap pictures from Pi camera at daily, hourly or minute intervals.
- Upload images to any FTP server.
- Designed to work under unstable network conditions.
- Automatic recovery, even if network is down for a any amount of time.
- Automatic deletion of old images (older than N days).
- Built-in web server for snapping picture and viewing result instantly.

## Installation

For brand new Raspberry Pi devices, make sure you enable SSH and the camera module.  With Rasibian OS, this is located in the main menu, "Raspberry Pi Configuration" dialog.  Then, open a Terminal and make sure your packages are up to date, and install [curl](https://curl.haxx.se/) and [Node.js](https://nodejs.org/en/):

```
sudo apt-get update
sudo apt-get install curl
sudo apt-get install node
```

Once that is complete, become root and install the **picam** software:

```
sudo bash
mkdir -p /opt/picam
cd /opt/picam
curl -L https://github.com/jhuckaby/picam/archive/master.zip | tar zxvf - --strip-components 1
chmod 755 server.js
mkdir temp && chmod 777 temp
```

As a final step, issue these three commands to make sure the **picam** server starts up at server boot:

```
cp /opt/picam/picam.init /etc/init.d/picam
chmod 775 /etc/init.d/picam
update-rc.d picam defaults
```

That's it!  Start the server with this command:

```
/etc/init.d/picam start
```

## Configuration

The picam configuration file will be installed to `/opt/picam/config.json` and has this format:

```js
{
	"webServerPort": 80,
	"logFile": "picam.log",
	"tempDir": "temp",
	"snapshotCommand": "/usr/bin/raspistill",
	"snapshotOpts": "",
	"imageWidth": 1920,
	"imageRotate": 0,
	"imageFormat": "jpg",
	"imageQuality": 90,
	"filenamePrefix": "image-",
	"curlCommand": "/usr/bin/curl",
	"curlOpts": "--retry 100 --retry-max-time 60 -v",
	"ftpHostname": "FTP.YOURSERVER.COM",
	"ftpUsername": "YOUR_USERNAME",
	"ftpPassword": "YOUR_PASSWORD",
	"ftpDirectory": "path/to/your/images",
	"keepDays": 90,
	"schedule": {
		"00:00": "snapshotUpload",
		"04:30": "deleteOldFiles",
		":30": "uploadAllFiles"
	}
}
```

Here are descriptions of the configuration properties:

| Property | Description |
|----------|-------------|
| `webServerPort` | Which port to listen on (80 is the default for HTTP). |
| `logFile` | Path and filename of the log file, relative to the base dir (`/opt/picam`). |
| `tempDir` | Path to temp directory where local images are stored, relative to the base dir (`/opt/picam`). |
| `snapshotCommand` | The actual command to use to take Pi camera snapshots, should be `/usr/bin/raspistill`. |
| `snapshotOpts` | Optional arguments to pass to the `raspistill` command. |
| `imageWidth` | Optionally scale images down to the specified width in pixels (height is calculated automatically), defaults to `1920`. |
| `imageRotate` | Optionally rotate image by the specified number of degrees. |
| `imageFormat` | The image format to use (`jpg` or `png`).  Defaults to `jpg`. |
| `imageQuality` | Set the image quality from 1 - 100 (only for `jpg` format). |
| `filenamePrefix` | Optional filename prefix, defaults to `image-`. |
| `curlCommand` | Location to the `curl` binary on the Pi.  Typical location is `/usr/bin/curl`. |
| `curlOpts` | Optional arguments to pass to `curl` which can include retries. |
| `ftpHostname` | FTP hostname for uploading images. |
| `ftpUsername` | FTP username for authenticating uploads. |
| `ftpPassword` | FTP password for authenticating uploads. |
| `ftpDirectory` | FTP remote directory for image upload (optional, defaults to FTP user's home dir). |
| `keepDays` | Maximum number of days to keep images on server before deleting (optional). |
| `schedule` | When to snapshot, upload and delete files (see below). |

### Schedule

The `schedule` configuration property should be and object containing specific keys, describing when events should execute.  The keys can be any of the following:

| Key Syntax | Description |
|------------|-------------|
| `HH::MM` | Run once per day, at the specified hour and minute. |
| `:MM` | Run hourly, at the specified minute. |
| `minute` | Run every minute, on the minute, every hour. |
| `hour` | Run once per hour on the hour, same as `:00`. |
| `day` | Run once per day at midnight, same as `00:00`. |
| `month` | Run once per month at midnight on the 1st. |
| `year` | Run once per year on January 1st at midnight. |

The values (commands to execute) should be any of the following (strings):

| Command | Description |
|---------|-------------|
| `snapshotUpload` | Take snapshot and upload it via FTP. |
| `deleteOldFiles` | Delete old files from the FTP server (older than `keepDays` days). |
| `uploadAllFiles` | Retry any pending files that may have failed on the previous upload attempt. |

Here is the default schedule:

```js
"schedule": {
	"00:00": "snapshotUpload",
	"04:30": "deleteOldFiles",
	":30": "uploadAllFiles"
}
```

The default schedule will take and upload snapshots daily at midnight (`00:00`).  It is also set to delete old files (number of days specified by the `keepDays` config property) at 4:30 AM (`04:30`) local server time.  Also, it will keep trying to upload files every hour on the half hour (`:30`).  This is for retrying failed uploads.

If you want to snap images hourly instead of daily, change the `snapshotUpload` key to something like this:

```
"schedule": {
	":00": "snapshotUpload"
}
```

If you want images every minute of every hour of every day, you can use the keyword `minute`, like this:

```
"schedule": {
	"minute": "snapshotUpload"
}
```

## Snapshots

Image snapshots are designed to be taken using the [raspistill](https://www.raspberrypi.org/documentation/usage/camera/raspicam/raspistill.md) utility, which should come with your Raspberry Pi (assuming you have Raspbian OS).  You can specify the desired image size via the `imageWidth` configuration property, the image format via `imageFormat`, among others.  These properties all become arguments on the `raspistill` command.  Example command:

```
/usr/bin/raspistill -rot 90 -w 1920 -q 90 -o image-2018-05-21-00-00-10.jpg
```

The image files themselves are always named using the current year, month, day, hour, minute and second: `YYYY-MM-DD-HH-MI-SS`.  This is so the FTP deletion system can identify when they were first uploaded.  However, you can supply your own filename prefix via the `filenamePrefix` configuration property.  This defaults to `image-`.  Example filename:

```
image-2018-05-21-00-00-10.jpg
```

## HTTP APIs

The built-in web server allows you to run certain image commands via a web browser.  Just construct a URL to your Raspberry Pi's IP address (or hostname, if you have that configured in DNS), and include one of the following URIs.  Here is the list of available commands:

### /snapshot

This instructs the Pi to immediately take a snapshot, and send the image back to the browser.  This allows you quickly "see" what the Pi camera is seeing.  It does not upload the image to the FTP server.  Example URL:

```
http://192.168.1.10/snapshot
```

### /run

This instructs the Pi to run a snapshot + upload, just like the scheduled `snapshotUpload` command.  This will not display the image in the browser, but rather just instructs the Pi to run the two commands in the background.  Example URL:

```
http://192.168.1.10/run
```

### /upload

This instructs the Pi to upload any pending images that may have failed to upload on previous attempts.  This is the same as the `uploadAllFiles` scheduled command.  This will not display the image in the browser, but rather just instructs the Pi to run the command in the background.  Example URL:

```
http://192.168.1.10/upload
```

### /delete

This instructs the Pi to delete old images from the FTP server, based on the `keepDays` configuration property.  This is the same as the `deleteOldFiles` scheduled command.  This will not display anything in the browser, but rather just instructs the Pi to run the command in the background.  Example URL:

```
http://192.168.1.10/delete
```

## References

- [Raspberry Pi](https://www.raspberrypi.org)
- [Raspbian OS](https://www.raspbian.org/)
- [Node.js](https://nodejs.org/en/)
- [raspistill](https://www.raspberrypi.org/documentation/usage/camera/raspicam/raspistill.md)

## License

The MIT License (MIT)

Copyright (c) 2018 Joseph Huckaby

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
