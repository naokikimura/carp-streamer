# carp-streamer

[![npm version](https://badge.fury.io/js/carp-streamer.svg)](https://badge.fury.io/js/carp-streamer)
[![Known Vulnerabilities](https://snyk.io//test/github/naokikimura/carp-streamer/badge.svg?targetFile=package.json)](https://snyk.io//test/github/naokikimura/carp-streamer?targetFile=package.json)

## Installation

```bash
npm install -g carp-streamer
```

## Configuration

### Set an Application Config File

```bash
export BOX_APP_CONFIG=~/Downloads/211349463_aagtkjaz_config.json
```

## Usage

Execute the command with the following arguments.
- Source: directory path of local computer
- Sink: Folder ID of Box

If you want to backup the desktop folder of the local computer to the root folder of Box, execute as follows.

```bash
carp-streamer ~/Desktop 0
```

There is also a `--dry-run` option.

```bash
carp-streamer --dry-run ~/Desktop 0
```

## Contributing

Bug reports and pull requests are welcome on GitHub at https://github.com/naokikimura/carp-streamer.
