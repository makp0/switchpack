# Third-party software

The compiled CLI includes Commander.js (MIT), fflate (MIT), and the Bun runtime
(MIT, with its own third-party notices). Their upstream license and notice files:

- [Commander.js](https://github.com/tj/commander.js/blob/master/LICENSE)
- [fflate](https://github.com/101arrowz/fflate/blob/master/LICENSE)
- [Bun](https://github.com/oven-sh/bun/blob/main/LICENSE.md)

Release archives include copies under `licenses/`.
The native bridge dynamically links to [libmtp](https://github.com/libmtp/libmtp),
licensed LGPL-2.1-or-later. Homebrew installs libmtp separately; switchpack does
not distribute a modified or statically linked copy.
