#!/usr/bin/env python3
"""Explicit disposable-container proof of the actual closed daemon/CNI path.

Requires Linux root, ip, nft, unshare, nsenter, Python, and an already built
binary. Run only in a new network-disabled container with NET_ADMIN/SYS_ADMIN
and permission to unshare a network namespace. No host namespaces or writable
host volumes. This fixture does not prove CNI ordering, gVisor or authorization.
"""
import argparse
import array
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def run(*args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=10, check=True, **kwargs)


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_until(predicate, label):
    deadline = time.monotonic() + 5
    while not predicate():
        require(time.monotonic() < deadline, label)
        time.sleep(0.03)


SERVER = """
import socket
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(('0.0.0.0',18763)); s.listen(8)
while True:
 c,_=s.accept(); c.sendall(b'fence-live-control'); c.close()
"""
CLIENT = """
import socket,sys
try:
 with socket.create_connection((sys.argv[1],18763),0.7) as s:
  assert s.recv(64)==b'fence-live-control'
except (OSError,AssertionError): sys.exit(2)
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--scenario', choices=['closed','caller-loss','link-replacement','incomplete-readback'], default='closed')
    parser.add_argument('--isolated-container', action='store_true', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0 and Path('/.dockerenv').exists(), 'requires disposable Docker container')
    # Refuse an existing routed environment. Only loopback may exist initially.
    links = json.loads(run('ip', '-j', 'link', 'show').stdout)
    require([link['ifname'] for link in links] == ['lo'], 'fixture requires network none')
    require(all(route.get('dev') == 'lo' for route in json.loads(run('ip', '-j', 'route', 'show', 'table', 'all').stdout)), 'unexpected initial routes')
    binary = str(Path(args.binary).resolve(strict=True))
    nft = str(Path('/usr/sbin/nft').resolve(strict=True))
    digest = hashlib.sha256(Path(nft).read_bytes()).hexdigest()
    processes = []
    directory = Path('/var/lib/oce-network-fence/operations')
    socket_path = Path('/run/oce-network-fence/control.sock')
    require(not directory.exists() and not socket_path.parent.exists(), 'fresh fixture directories required')
    directory.mkdir(parents=True, mode=0o700)
    socket_path.parent.mkdir(mode=0o700)
    original = os.readlink('/proc/self/ns/net')
    try:
        child = subprocess.Popen(['unshare', '--net', 'sleep', '120'])
        processes.append(child)
        ns = f'/proc/{child.pid}/ns/net'
        wait_until(lambda: child.poll() is None and os.readlink(ns) != original, 'child namespace absent')
        enter = ['nsenter', '--net=' + ns, '--']
        run('ip', 'link', 'add', 'fencehost', 'type', 'veth', 'peer', 'name', 'fencepod')
        run('ip', 'link', 'set', 'fencepod', 'netns', str(child.pid))
        run('ip', 'addr', 'add', '192.0.2.1/30', 'dev', 'fencehost')
        run('ip', 'link', 'set', 'fencehost', 'up')
        run(*enter, 'ip', 'addr', 'add', '192.0.2.2/30', 'dev', 'fencepod')
        run(*enter, 'ip', 'link', 'set', 'fencepod', 'up')
        for command in ([sys.executable, '-c', SERVER], [*enter, sys.executable, '-c', SERVER]):
            processes.append(subprocess.Popen(command))

        def connects(in_pod):
            command = [*(enter if in_pod else []), sys.executable, '-c', CLIENT, '192.0.2.1' if in_pod else '192.0.2.2']
            return subprocess.run(command, capture_output=True, timeout=3).returncode == 0

        # Both exact receivers must work before a timeout can count as a deny.
        wait_until(lambda: connects(False) and connects(True), 'positive controls unavailable')
        daemon = subprocess.Popen([binary, 'serve', nft, digest])
        processes.append(daemon)
        wait_until(lambda: socket_path.exists() or daemon.poll() is not None, 'daemon did not listen')
        require(daemon.poll() is None, 'daemon startup failed')
        config = json.dumps({'cniVersion':'1.0.0','name':'closed-test','type':'oce-network-fence','prevResult':{'cniVersion':'1.0.0','interfaces':[]}})
        env = dict(os.environ, CNI_CONTAINERID='original-sandbox', CNI_IFNAME='fencepod', CNI_NETNS=ns)

        def cni(operation, success):
            result = subprocess.run([binary], env=dict(env, CNI_COMMAND=operation), input=config, text=True, capture_output=True, timeout=15)
            if (result.returncode == 0) != success:
                print('fixture receipt diagnostics:', [p.read_text() for p in directory.glob('*.json')], flush=True)
                print('fixture kernel diagnostics:', run('nft', '-j', 'list', 'ruleset').stdout, flush=True)
            require((result.returncode == 0) == success, f'{operation}: {result.stdout} {result.stderr}')
            return result

        if args.scenario == 'caller-loss':
            # Use the real protected transport, then lose the caller without
            # receiving its reply. Kernel effects remain the daemon's obligation.
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as connection:
                connection.connect(str(socket_path))
                fd = os.open(ns, os.O_RDONLY)
                try:
                    request = json.dumps({'schemaVersion':1,'operation':'ADD','containerId':env['CNI_CONTAINERID'],'networkName':'closed-test','interfaceName':'fencepod'}).encode()
                    connection.sendmsg([request], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i',[fd]))])
                finally:
                    os.close(fd)
            def committed():
                receipts = list(directory.glob('*.json'))
                return len(receipts) == 1 and json.loads(receipts[0].read_text())['status'] == 'closed'
            wait_until(committed, 'lost caller discarded attachment ownership')
        else:
            cni('ADD', args.scenario != 'incomplete-readback')
        cni('CHECK', args.scenario != 'incomplete-readback')
        expected_closed = args.scenario != 'incomplete-readback'
        require(connects(False) != expected_closed and connects(True) != expected_closed, 'unexpected attachment traffic')
        receipts = list(directory.glob('*.json'))
        require(len(receipts) == 1, 'one original receipt required')
        receipt = json.loads(receipts[0].read_text())
        if args.scenario == 'incomplete-readback':
            require(receipt['status'] == 'installation-unknown' and receipt['kernelIdentity'] is None, 'incomplete readback became an installed identity')
        else:
            require(receipt['status'] == 'closed' and receipt['kernelIdentity'], 'missing actual installed identity')
        table = receipt['operationRef']
        observed = json.loads(run('nft','-j','list','table','netdev',table).stdout)

        if args.scenario == 'link-replacement':
            # An identically named successor is a new attachment. A stale CHECK
            # must neither certify it nor accidentally remove its link.
            prior_index = run('ip','-j','link','show','fencehost').stdout
            run('ip','link','del','fencehost')
            run('ip','link','add','fencehost','type','veth','peer','name','fencepod')
            run('ip','link','set','fencepod','netns',str(child.pid))
            require(run('ip','-j','link','show','fencehost').stdout != prior_index, 'link was not replaced')
            cni('CHECK', False)
            require(json.loads(receipts[0].read_text())['status'] == 'observation-unknown', 'stale link retained closed status')
            run('ip','link','show','fencehost')
            print(json.dumps({'status':'passed','scenario':args.scenario,'kernel':os.uname().release,'nft':run(nft,'--version').stdout.strip(),'assertions':['healthy-bidirectional-tcp','production-cni-add-check','bidirectional-drop','same-name-successor-refused','successor-not-deleted']},sort_keys=True))
            return

        # DEL retains uncertainty and must never remove the original drop rules.
        cni('DEL', False)
        require(json.loads(receipts[0].read_text())['status'] == 'cleanup-unknown', 'DEL falsely terminal')
        require(connects(False) != expected_closed and connects(True) != expected_closed, 'DEL changed traffic')
        daemon.kill(); daemon.wait()
        require(connects(False) != expected_closed and connects(True) != expected_closed, 'daemon death changed traffic')
        restart = subprocess.run([binary,'serve',nft,digest], capture_output=True, timeout=5)
        require(restart.returncode != 0, 'restart adopted unresolved attachment')
        require(os.readlink('/proc/self/ns/net') == original, 'fixture entered child namespace')
        assertions = ['healthy-bidirectional-tcp', 'bidirectional-drop' if expected_closed else 'neutral-anchor-passes-traffic',
                      'del-preserves-policy-and-uncertainty',
                      'daemon-death-preserves-policy',
                      'restart-refuses-unresolved-ownership']
        if args.scenario == 'incomplete-readback':
            chains = [obj['chain'] for obj in observed['nftables'] if 'chain' in obj]
            require(len(chains) == 2 and all('dev' not in chain for chain in chains),
                    'negative fixture did not omit device readback')
            assertions += ['incomplete-readback-refuses-add-and-check',
                           'uncertain-installation-retains-receipt']
        else:
            assertions += ['production-cni-check', 'installed-identity-readback']
            assertions += ['caller-loss-retains-operation'] if args.scenario == 'caller-loss' else ['production-cni-add']
        print(json.dumps({'status':'passed','scenario':args.scenario,
                          'kernel':os.uname().release,
                          'nft':run(nft,'--version').stdout.strip(),
                          'assertions':assertions,'observed':observed},sort_keys=True))
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        # Exact fixture link only. Container removal retires its private tables.
        subprocess.run(['ip','link','del','fencehost'],capture_output=True,timeout=5)


if __name__ == '__main__':
    main()
