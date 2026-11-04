import { buildPdf } from '../pdf/write-pdf.js';

/**
 * A realistic fictional product manual (14 pages) for demos and tests:
 * "NetPro X200 Wi-Fi 6 Router - User Manual". Every page carries a running header and
 * footer so header/footer removal is exercised too.
 */
const H1 = (text) => ({ text, size: 16, bold: true });
const H2 = (text) => ({ text, size: 13, bold: true });
const P = (text) => text;
const GAP = '';

export const SAMPLE_TITLE = 'NetPro X200 Wi-Fi 6 Router - User Manual';

export function sampleManualPages() {
  return [
    [
      { text: 'NetPro X200', size: 26, bold: true },
      { text: 'Wi-Fi 6 Dual-Band Router', size: 16 },
      GAP,
      H2('User Manual - Firmware 3.4'),
      P('Document number NP-X200-UM-EN, revision C. Applies to hardware versions 1.0 and 1.1.'),
      GAP,
      H2('Contents'),
      P('1 Safety Instructions ... 2'),
      P('2 Package Contents and Specifications ... 3'),
      P('3 LED Indicators and Buttons ... 4'),
      P('4 Installation and First Setup ... 5'),
      P('5 Wireless Settings ... 7'),
      P('6 Parental Controls and Guest Network ... 8'),
      P('7 Firmware Update ... 9'),
      P('8 Factory Reset ... 10'),
      P('9 Troubleshooting ... 11'),
      P('10 Error Codes ... 12'),
      P('11 Warranty and Support ... 13'),
    ],
    [
      H1('1 Safety Instructions'),
      P('Read all instructions before installing the router. Keep this manual for future reference.'),
      P('Use only the 12 V / 1.5 A power adapter supplied in the box (model PA-1215). Using a different adapter can damage the router and voids the warranty.'),
      P('Operating temperature is 0 to 40 degrees Celsius. Do not place the router in direct sunlight, near a heater, or inside a closed metal cabinet.'),
      P('Keep at least 20 cm between the antennas and the body of any person during operation.'),
      P('Do not open the housing. There are no user-serviceable parts inside. Opening the housing voids the warranty.'),
      P('Unplug the router during lightning storms or when it will not be used for a long time.'),
    ],
    [
      H1('2 Package Contents and Specifications'),
      H2('2.1 Package contents'),
      P('One NetPro X200 router, one 12 V power adapter (PA-1215), one 1.5 m Cat6 Ethernet cable, a quick installation guide and a warranty card.'),
      H2('2.2 Technical specifications'),
      P('Wireless standard: IEEE 802.11ax (Wi-Fi 6), backward compatible with 802.11a/b/g/n/ac.'),
      P('Bands: 2.4 GHz up to 574 Mbps and 5 GHz up to 2402 Mbps (AX3000 class).'),
      P('Ports: one 2.5 Gbps WAN port, four 1 Gbps LAN ports and one USB 3.0 port for storage sharing.'),
      P('Processor: 1.5 GHz quad-core. Memory: 512 MB RAM, 256 MB flash.'),
      P('Security: WPA3-Personal, WPA2/WPA3 mixed mode, built-in firewall and automatic security updates.'),
      P('Maximum recommended number of connected devices: 64.'),
      P('Dimensions: 260 x 160 x 45 mm. Weight: 620 g. Power consumption: 18 W maximum.'),
    ],
    [
      H1('3 LED Indicators and Buttons'),
      H2('3.1 Status LED'),
      P('Solid white: the router is working normally and is connected to the internet.'),
      P('Blinking white: the router is starting up or a firmware update is in progress. Do not unplug the router while the LED blinks white.'),
      P('Solid amber: the router is working but has no internet connection. See section 9.1.'),
      P('Blinking amber: WPS pairing is active (up to 2 minutes).'),
      P('Solid red: hardware fault or failed firmware update. See error code E-301 in section 10.'),
      P('Off: no power. Check the adapter and the power switch on the back panel.'),
      H2('3.2 Buttons'),
      P('Power button: turns the router on or off.'),
      P('WPS button: press for 2 seconds to start WPS pairing with a device.'),
      P('RESET button: recessed pin-hole on the back panel. A short press of 1 to 3 seconds restarts the router. Holding it for 10 seconds performs a factory reset (see section 8).'),
    ],
    [
      H1('4 Installation and First Setup'),
      H2('4.1 Connecting the hardware'),
      P('1. Turn off your modem.'),
      P('2. Connect the blue WAN port of the router to the modem with the supplied Ethernet cable.'),
      P('3. Turn on the modem and wait 2 minutes.'),
      P('4. Connect the power adapter and press the power button. Wait until the status LED is solid white or solid amber (about 90 seconds).'),
      H2('4.2 Setup with the NetPro app'),
      P('Install the NetPro Home app (iOS 15 or later, Android 9 or later). Connect your phone to the Wi-Fi network printed on the label on the bottom of the router (default name NetPro-X200-XXXX, where XXXX are the last four characters of the MAC address).'),
      P('Open the app, tap Add Device, and follow the instructions. The app detects the connection type automatically (DHCP, PPPoE or static IP).'),
    ],
    [
      H2('4.3 Setup with a web browser'),
      P('Connect a computer to a LAN port or to the default Wi-Fi network. Open a browser and go to http://192.168.50.1 or http://netpro.home.'),
      P('The default administrator username is admin and the default password is printed on the label on the bottom of the router. You must change the administrator password during the first login.'),
      P('The setup wizard asks for the internet connection type. For PPPoE (common for DSL and fiber), enter the username and password provided by your internet service provider.'),
      H2('4.4 Placement tips'),
      P('Place the router in a central, elevated and open location. Keep it at least 1 m away from microwaves, cordless phones and baby monitors, which use the 2.4 GHz band.'),
      P('Point the four external antennas straight up for the best coverage on a single floor. For multi-floor homes, angle two antennas at 45 degrees.'),
    ],
    [
      H1('5 Wireless Settings'),
      H2('5.1 Changing the Wi-Fi name and password'),
      P('In the web interface go to Wireless > Basic Settings. Enter a new network name (SSID) and a password of at least 8 characters, then click Save. All devices must reconnect with the new password.'),
      H2('5.2 Smart Connect (band steering)'),
      P('Smart Connect is enabled by default. It uses one network name for both bands and moves devices to the best band automatically. To use separate names for 2.4 GHz and 5 GHz, go to Wireless > Smart Connect and turn it off.'),
      H2('5.3 Channel and channel width'),
      P('Channel selection is Auto by default. If the connection is unstable in a crowded building, set the 2.4 GHz channel manually to 1, 6 or 11 and the channel width to 20 MHz. For 5 GHz, a width of 80 MHz gives the best balance between speed and stability; 160 MHz is faster but more sensitive to interference.'),
      H2('5.4 Security mode'),
      P('The default security mode is WPA2/WPA3 mixed. Older devices that cannot connect may need WPA2-Personal (AES). Never use open or WEP security.'),
    ],
    [
      H1('6 Parental Controls and Guest Network'),
      H2('6.1 Guest network'),
      P('Go to Wireless > Guest Network and turn on the guest network for 2.4 GHz, 5 GHz or both. Guests get internet access but cannot see devices on your main network. You can limit guest access to 1, 4 or 24 hours, or set it to Always.'),
      H2('6.2 Parental controls'),
      P('Go to Advanced > Parental Controls. Create a profile for each family member, assign their devices, then set daily time limits, bedtime schedules and content filters (Child, Pre-teen, Teen or Adult). Paused devices lose internet access immediately.'),
      H2('6.3 Quality of Service (QoS)'),
      P('Adaptive QoS gives priority to video calls and gaming. Enable it under Advanced > QoS and enter your real upload and download speeds measured with a speed test.'),
    ],
    [
      H1('7 Firmware Update'),
      P('NetPro releases firmware updates that add features and fix security issues. Automatic updates are enabled by default and run between 2:00 and 4:00 at night.'),
      H2('7.1 Manual update'),
      P('1. Download the latest firmware file for the X200 from support.netpro.example/x200. Make sure the file name starts with X200_FW.'),
      P('2. In the web interface go to System > Firmware Upgrade and click Browse to select the file.'),
      P('3. Click Upgrade. The update takes about 4 minutes and the status LED blinks white.'),
      P('4. Do not turn off the router or close the browser during the update. Interrupting the update can damage the router (error E-301).'),
      P('Your settings are kept after a firmware update. Downgrading to a firmware older than 3.0 is not supported.'),
    ],
    [
      H1('8 Factory Reset'),
      P('A factory reset erases all settings, including the Wi-Fi name, passwords, parental control profiles and port forwarding rules, and restores the factory defaults printed on the label.'),
      H2('8.1 Reset with the RESET button'),
      P('1. Make sure the router is powered on and the status LED is lit.'),
      P('2. Use a paper clip to press and hold the RESET button on the back panel for 10 seconds, until the status LED blinks amber quickly.'),
      P('3. Release the button. The router restarts, which takes about 2 minutes.'),
      P('4. Set up the router again as described in section 4.'),
      H2('8.2 Reset from the web interface'),
      P('Go to System > Backup and Restore and click Factory Default. Before resetting, you can click Save Settings to download a backup file and restore it later.'),
    ],
    [
      H1('9 Troubleshooting'),
      H2('9.1 No internet connection (status LED solid amber)'),
      P('Restart the modem and then the router. Check that the cable is in the blue WAN port and not in a LAN port. If your provider uses PPPoE, check the PPPoE username and password under Internet > Connection. If the problem continues, contact your internet service provider to confirm that the line is active.'),
      H2('9.2 Wi-Fi keeps disconnecting or is slow'),
      P('Move the router to a central location away from interference (see section 4.4). Update to the latest firmware. Set the 2.4 GHz channel manually to 1, 6 or 11 (section 5.3). For devices that drop the connection, turn off Smart Connect and connect them to the 2.4 GHz network directly.'),
      H2('9.3 Forgot the administrator password'),
      P('The administrator password cannot be recovered. Perform a factory reset (section 8) and set up the router again.'),
      H2('9.4 Cannot open the web interface'),
      P('Make sure your computer is connected to the router, then try http://192.168.50.1 instead of netpro.home. Disable VPN software and clear the browser cache.'),
    ],
    [
      H1('10 Error Codes'),
      P('Error codes appear in the NetPro Home app and in the web interface under System > Log.'),
      P('E-101 WAN cable not detected: connect the modem to the blue WAN port and check the cable.'),
      P('E-102 PPPoE authentication failed: the PPPoE username or password is wrong. Re-enter the credentials from your internet service provider.'),
      P('E-103 No IP address from the modem: restart the modem, wait 2 minutes, then restart the router.'),
      P('E-201 Wireless radio overheating: the router reduced transmit power. Improve ventilation and keep the router away from heat sources.'),
      P('E-202 Too many connected devices: more than 64 devices are connected. Disconnect unused devices or enable the guest network for visitors.'),
      P('E-301 Firmware verification failed: the firmware is damaged, usually after an interrupted update. Hold the RESET button while powering on the router for 30 seconds to start recovery mode, then upload the firmware again from http://192.168.50.1/recovery. If the LED stays solid red, contact support for a replacement.'),
      P('E-401 USB storage error: the drive is not formatted as FAT32, exFAT or NTFS, or it draws more than 900 mA.'),
    ],
    [
      H1('11 Warranty and Support'),
      H2('11.1 Limited warranty'),
      P('NetPro warrants the X200 against defects in materials and workmanship for 2 years from the date of purchase (3 years in the European Union). The warranty does not cover damage from lightning, liquid, drops, unauthorized repairs, or use of a non-original power adapter.'),
      P('To make a warranty claim you need the proof of purchase and the serial number (S/N) printed on the label on the bottom of the router.'),
      H2('11.2 Returns'),
      P('Products bought directly from the NetPro online store can be returned within 30 days in the original packaging for a full refund.'),
      H2('11.3 Contact support'),
      P('Phone support is available Monday to Friday, 8:00 to 20:00 CET, at +1-800-555-0142. Chat and email support (support@netpro.example) are available 24/7. Have the serial number and firmware version ready.'),
    ],
    [
      H1('Appendix A Regulatory Information'),
      P('The NetPro X200 complies with Part 15 of the FCC Rules and with the EU Radio Equipment Directive 2014/53/EU. The full declaration of conformity is available at support.netpro.example/doc.'),
      P('In the 5150 to 5350 MHz band the device is restricted to indoor use in the EU, UK, Switzerland and Turkey.'),
      P('Dispose of the router at an electronic waste collection point. Do not throw it away with household waste.'),
    ],
  ];
}

export function buildSampleManualPdf() {
  return buildPdf(sampleManualPages(), {
    title: SAMPLE_TITLE,
    footer: (p, n) => `NetPro X200 User Manual | NP-X200-UM-EN rev C | Page ${p} of ${n}`,
  });
}
