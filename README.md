# LAN Drop

LAN Drop sends files directly between Windows computers on the same local network. It does not upload files to a cloud service. The receiving computer shows an approval prompt before saving each file.

## Use on two computers

1. Open LAN Drop on both computers and connect them to the same local network.
2. If Windows Firewall asks, allow LAN Drop on **Private networks**.
3. If Windscribe is running, turn on **Preferences → Connection → Allow LAN Traffic**.
4. Drag files into the app, choose the other computer, and select **Send files**.
5. Accept the incoming file on the receiving computer. Files save to `Downloads\LAN Drop` by default.

The computers must both be awake with LAN Drop open. If automatic discovery does not find the other computer, enter its address shown in the app, including the port.

## Download and update

Download the [latest portable ZIP](https://github.com/j355311/lan-drop/releases/latest/download/LAN.Drop.-.Windows.Portable.zip), extract it, and run `LAN Drop.exe`. The app's **Download latest** button opens the same latest release download. To replace an older copy, close LAN Drop first, then extract the new ZIP and replace the executable.

## Run and package

From this folder, run `npm install`, then `npm start` for development. Run `npm run dist` to create a portable Windows executable in `dist`.

The first version is for the same local network. Transfers use the local network and are not encrypted in transit; only run it on a network you trust.
