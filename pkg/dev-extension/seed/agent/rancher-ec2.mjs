#!/usr/bin/env node
// A Rancher on one EC2 instance, made directly, with nothing between here and AWS.
//
// WHY THIS EXISTS, beside the Apps Plus `rancher-single` app that does the same job.
//
// That app asks for a Rancher like this: an AppInstance renders a Fleet Bundle, Fleet delivers
// it, Rancher's CAPI provisioner builds an EC2 node and registers it as a downstream cluster of
// the parent, a Helm release installs Rancher into that cluster, and a bootstrap sidecar
// configures it. Seven links, and every one of them has to keep working for ever - including a
// cluster-agent tunnel from AWS back to a Rancher on somebody's home connection, and two
// Ranchers reconciling one `cattle-system` because the installed one runs --add-local=true.
//
// Measured across fifty days and four instances, that tunnel never once held for five seconds.
// The specific defect behind it is fixed (a missing `cattle-system/rancher` Service), but the
// chain is still seven links long and each is a way to lose a Rancher.
//
// This is the other answer: run one EC2 instance whose user-data installs docker and starts
// `rancher/rancher` as a container. Three links - the instance, docker, the image - and the
// parent is not one of them. Nothing here registers a cluster, nothing waits on Fleet, and no
// agent has to dial home. It is the shape that has been working in the rancher-now project all
// along.
//
// WHAT IT GIVES UP, honestly. There is no downstream cluster, so the parent cannot proxy into
// it (it cannot today either - the agent is dead) and Fleet cannot deliver to it, which is how
// shares reach an instance now. A share here is another container on the same box, or a
// manifest applied with the instance's own kubeconfig; both are simpler than a Bundle.
//
// No SDK and no AWS CLI: the CLI is 222 MB in a pod that is rebuilt often, and the EC2 Query
// API over SigV4 is sixty lines of crypto that is already in node.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'us-west-2';
/** How this script recognises its own instances, and nothing else's. */
const TAG = 'dev.rancher.io/rancher';

/**
 * The credential, read from the one place it already lives.
 *
 * Rancher keeps cloud credentials in cattle-global-data as `amazonec2credentialConfig-*` keys.
 * Read through kubectl with this pod's own ServiceAccount rather than copied anywhere: there is
 * no second store to rotate, and nothing here ever prints it.
 */
function credential(name) {
  const raw = execFileSync('kubectl', [
    'get', 'secret', '-n', 'cattle-global-data', name, '-o', 'json',
  ], { encoding: 'utf8' });
  const data = JSON.parse(raw).data || {};
  const get = (key) => Buffer.from(data[`amazonec2credentialConfig-${ key }`] || '', 'base64').toString('utf8').trim();
  const id = get('accessKey');
  const secret = get('secretKey');

  if (!id || !secret) {
    throw new Error(`${ name } is not an amazonec2 credential`);
  }

  return { id, secret, region: get('defaultRegion') || REGION };
}

const hmac = (key, value) => crypto.createHmac('sha256', key).update(value, 'utf8').digest();
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * One EC2 Query API call, signed.
 *
 * POST with a form body, which keeps the canonical request trivial: the path is always `/`, the
 * query string is always empty, and the only signed headers are the three that have to be.
 */
async function ec2(cred, params) {
  const host = `ec2.${ cred.region }.amazonaws.com`;
  const body = new URLSearchParams({ Version: '2016-11-15', ...params }).toString();
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = now.slice(0, 8);
  const scope = `${ day }/${ cred.region }/ec2/aws4_request`;
  const canonical = [
    'POST', '/', '',
    `content-type:application/x-www-form-urlencoded; charset=utf-8`,
    `host:${ host }`,
    `x-amz-date:${ now }`,
    '', 'content-type;host;x-amz-date', sha256(body),
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  const signature = hmac(
    hmac(hmac(hmac(hmac(`AWS4${ cred.secret }`, day), cred.region), 'ec2'), 'aws4_request'),
    toSign,
  ).toString('hex');
  const response = await fetch(`https://${ host }/`, {
    method:  'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'x-amz-date':   now,
      authorization:  `AWS4-HMAC-SHA256 Credential=${ cred.id }/${ scope }, SignedHeaders=content-type;host;x-amz-date, Signature=${ signature }`,
    },
    body,
  });
  const text = await response.text();

  if (!response.ok) {
    // The message, not the whole XML document, and never the request that carried the key.
    throw new Error(`EC2 ${ params.Action } -> ${ response.status }: ${ (/<Message>([^<]*)</.exec(text) || [])[1] || text.slice(0, 200) }`);
  }

  return text;
}

/** Everything between a repeated XML tag, which is all the parsing this needs. */
function all(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${ tag }>([\\s\\S]*?)</${ tag }>`, 'g'))].map((m) => m[1]);
}

function one(xml, tag) {
  return (new RegExp(`<${ tag }>([\\s\\S]*?)</${ tag }>`).exec(xml) || [])[1] || '';
}

/**
 * The newest Ubuntu 24.04 image, asked of AWS rather than written down.
 *
 * A hard-coded AMI id is wrong in every region but one and goes stale the first time Canonical
 * publishes; this is one call and is always right.
 */
async function ubuntu(cred) {
  const xml = await ec2(cred, {
    Action:                      'DescribeImages',
    'Owner.1':                   '099720109477',
    'Filter.1.Name':             'name',
    'Filter.1.Value.1':          'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
    'Filter.2.Name':             'state',
    'Filter.2.Value.1':          'available',
  });
  const images = all(xml, 'item')
    .filter((i) => one(i, 'imageId'))
    .map((i) => ({ id: one(i, 'imageId'), at: one(i, 'creationDate') }))
    .sort((a, b) => b.at.localeCompare(a.at));

  if (!images.length) {
    throw new Error('no Ubuntu 24.04 image found in this region');
  }

  return images[0].id;
}

/**
 * What the instance runs on first boot.
 *
 * `--restart=unless-stopped` is the whole availability story: the box reboots, docker comes
 * back, Rancher comes back. No agent, no tunnel, nothing to reconnect.
 *
 * The two sysctls are not optional - Rancher runs k3s inside this container and the default
 * inotify limits are too low for it, which shows up as a Rancher that starts and then wedges.
 */
function userData(image, password) {
  return Buffer.from(`#!/bin/bash
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io
systemctl enable --now docker
sysctl -w fs.inotify.max_user_instances=1024 || true
sysctl -w fs.inotify.max_user_watches=524288 || true
echo 'fs.inotify.max_user_instances=1024' >> /etc/sysctl.conf
echo 'fs.inotify.max_user_watches=524288' >> /etc/sysctl.conf
docker run -d --name rancher --privileged --restart=unless-stopped \\
  -p 80:80 -p 443:443 \\
  -e CATTLE_BOOTSTRAP_PASSWORD='${ password }' \\
  ${ image }
touch /var/log/rancher-bootstrap-done
`).toString('base64');
}

async function create(cred, name, opts) {
  const ami = opts.ami || await ubuntu(cred);
  const password = opts.password || crypto.randomBytes(16).toString('base64url');
  const params = {
    Action:                                        'RunInstances',
    ImageId:                                       ami,
    InstanceType:                                  opts.type,
    MinCount:                                      '1',
    MaxCount:                                      '1',
    UserData:                                      userData(opts.image, password),
    'BlockDeviceMapping.1.DeviceName':             '/dev/sda1',
    'BlockDeviceMapping.1.Ebs.VolumeSize':         String(opts.rootSize),
    // gp3 for the same reason the Apps Plus app chose it: a gp2 root's baseline is 3 IOPS per
    // GiB, and etcd inside this container is what everything else waits behind.
    'BlockDeviceMapping.1.Ebs.VolumeType':         'gp3',
    'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
    'TagSpecification.1.ResourceType':             'instance',
    'TagSpecification.1.Tag.1.Key':                'Name',
    'TagSpecification.1.Tag.1.Value':              name,
    'TagSpecification.1.Tag.2.Key':                TAG,
    'TagSpecification.1.Tag.2.Value':              name,
  };

  if (opts.securityGroup) {
    params['SecurityGroupId.1'] = opts.securityGroup;
  }
  if (opts.subnet) {
    params.SubnetId = opts.subnet;
  }
  if (opts.keyName) {
    params.KeyName = opts.keyName;
  }

  const xml = await ec2(cred, params);
  const id = one(xml, 'instanceId');

  console.log(JSON.stringify({
    name, instanceId: id, ami, password, state: 'pending',
  }));

  return id;
}

async function list(cred) {
  const xml = await ec2(cred, {
    Action:             'DescribeInstances',
    'Filter.1.Name':    `tag:${ TAG }`,
    'Filter.1.Value.1': '*',
    'Filter.2.Name':    'instance-state-name',
    'Filter.2.Value.1': 'pending',
    'Filter.2.Value.2': 'running',
    'Filter.2.Value.3': 'stopped',
  });

  // One item per instance, and the tag set is nested inside it - so the instance's own id is
  // the first instanceId in the block, not any that a tag happens to carry.
  return all(xml, 'instancesSet').flatMap((set) => all(set, 'item')).map((i) => ({
    name:  (all(i, 'item').map((t) => (one(t, 'key') === TAG ? one(t, 'value') : '')).find(Boolean)) || '',
    id:    one(i, 'instanceId'),
    state: one(one(i, 'instanceState'), 'name'),
    ip:    one(i, 'ipAddress'),
  })).filter((i) => i.id);
}

async function remove(cred, name) {
  const found = (await list(cred)).filter((i) => i.name === name || i.id === name);

  if (!found.length) {
    throw new Error(`no instance tagged ${ name }`);
  }
  for (const [n, instance] of found.entries()) {
    await ec2(cred, { Action: 'TerminateInstances', [`InstanceId.${ n + 1 }`]: instance.id });
  }
  console.log(JSON.stringify({ terminated: found.map((i) => i.id) }));
}

async function main() {
  const [verb, name] = process.argv.slice(2);
  const opts = {
    credential:    process.env.RANCHER_EC2_CREDENTIAL || '',
    type:          process.env.RANCHER_EC2_TYPE || 't3.xlarge',
    rootSize:      process.env.RANCHER_EC2_ROOT || '100',
    image:         process.env.RANCHER_EC2_IMAGE || 'rancher/rancher:v2.12.3',
    securityGroup: process.env.RANCHER_EC2_SG || '',
    subnet:        process.env.RANCHER_EC2_SUBNET || '',
    keyName:       process.env.RANCHER_EC2_KEY || '',
    ami:           process.env.RANCHER_EC2_AMI || '',
    password:      process.env.RANCHER_EC2_PASSWORD || '',
  };

  if (!opts.credential) {
    throw new Error('RANCHER_EC2_CREDENTIAL must name a cattle-global-data secret (a cc-xxxxx)');
  }
  const cred = credential(opts.credential);

  if (verb === 'create') {
    if (!name) {
      throw new Error('create needs a name');
    }
    await create(cred, name, opts);
  } else if (verb === 'list') {
    console.log(JSON.stringify(await list(cred), null, 1));
  } else if (verb === 'delete') {
    if (!name) {
      throw new Error('delete needs a name');
    }
    await remove(cred, name);
  } else {
    console.error('usage: rancher-ec2.mjs create <name> | list | delete <name>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
