// The two types this product is a UI over, as objects rather than a file to remember.
//
// They used to be `kubectl apply -f crds.yaml`, applied once out of band, on the argument that
// an extension is UI and should not install its own CRDs. That argument held while Apps Plus was
// its own extension somebody installed deliberately; it does not hold now that this extension
// *is* the thing that needs them - a Dev product with no Apps has no workspaces, no previews and
// no tools, so "install the extension" has to mean the types exist.
//
// Generated from apps-plus's crds.yaml (kept beside this file for reference) and applied by
// ensureAppsPlusCrds on load. Creating a CRD needs a cluster-admin, which whoever administers
// this Rancher is; for anyone else the create fails quietly and the pages say what is missing.
/* eslint-disable */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const APPS_PLUS_CRDS: any[] = [
  {
    "apiVersion": "apiextensions.k8s.io/v1",
    "kind": "CustomResourceDefinition",
    "metadata": {
      "name": "apps.appsplus.io"
    },
    "spec": {
      "group": "appsplus.io",
      "scope": "Cluster",
      "names": {
        "kind": "App",
        "plural": "apps",
        "singular": "app",
        "shortNames": [
          "apapp"
        ],
        "categories": [
          "appsplus"
        ]
      },
      "versions": [
        {
          "name": "v1alpha1",
          "served": true,
          "storage": true,
          "subresources": {
            "status": {}
          },
          "additionalPrinterColumns": [
            {
              "name": "Templates",
              "type": "integer",
              "jsonPath": ".status.templateCount"
            },
            {
              "name": "Age",
              "type": "date",
              "jsonPath": ".metadata.creationTimestamp"
            }
          ],
          "schema": {
            "openAPIV3Schema": {
              "type": "object",
              "properties": {
                "spec": {
                  "type": "object",
                  "properties": {
                    "description": {
                      "type": "string"
                    },
                    "templates": {
                      "type": "array",
                      "description": "The chart. Each entry is one YAML file applied to every target.",
                      "items": {
                        "type": "object",
                        "required": [
                          "name",
                          "content"
                        ],
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "content": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "values": {
                      "type": "object",
                      "description": "Default values, substituted into templates as ${key}. The keys are the app's declared parameters - only these (and the built-ins) are ever substituted, so a template's own ${...} syntax survives rendering.",
                      "x-kubernetes-preserve-unknown-fields": true
                    },
                    "valueLabels": {
                      "type": "object",
                      "description": "Human-readable names for the keys in values, shown on the install form. A key with no label is shown as itself.",
                      "x-kubernetes-preserve-unknown-fields": true
                    },
                    "defaultTargets": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "clusterName": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "clusterTemplate": {
                      "type": "string",
                      "description": "A provisioning.cattle.io Cluster manifest, for instances of this app that provision their own. Rendered with the same values as the templates above. Only its spec is used; name, workspace and ownership belong to the instance."
                    }
                  }
                },
                "status": {
                  "type": "object",
                  "x-kubernetes-preserve-unknown-fields": true
                }
              }
            }
          }
        }
      ]
    }
  },
  {
    "apiVersion": "apiextensions.k8s.io/v1",
    "kind": "CustomResourceDefinition",
    "metadata": {
      "name": "appinstances.appsplus.io"
    },
    "spec": {
      "group": "appsplus.io",
      "scope": "Cluster",
      "names": {
        "kind": "AppInstance",
        "plural": "appinstances",
        "singular": "appinstance",
        "shortNames": [
          "apinst"
        ],
        "categories": [
          "appsplus"
        ]
      },
      "versions": [
        {
          "name": "v1alpha1",
          "served": true,
          "storage": true,
          "subresources": {
            "status": {}
          },
          "additionalPrinterColumns": [
            {
              "name": "App",
              "type": "string",
              "jsonPath": ".spec.app"
            },
            {
              "name": "Namespace",
              "type": "string",
              "jsonPath": ".spec.namespace"
            },
            {
              "name": "Bundle",
              "type": "string",
              "jsonPath": ".status.bundleName"
            },
            {
              "name": "Age",
              "type": "date",
              "jsonPath": ".metadata.creationTimestamp"
            }
          ],
          "schema": {
            "openAPIV3Schema": {
              "type": "object",
              "properties": {
                "spec": {
                  "type": "object",
                  "required": [
                    "app"
                  ],
                  "properties": {
                    "app": {
                      "type": "string",
                      "description": "Name of the App this is an instance of."
                    },
                    "namespace": {
                      "type": "string",
                      "description": "Namespace the rendered resources land in on each target."
                    },
                    "values": {
                      "type": "object",
                      "description": "Overrides the App's values. Substituted into templates as ${key}.",
                      "x-kubernetes-preserve-unknown-fields": true
                    },
                    "targets": {
                      "type": "array",
                      "description": "Which existing clusters to deploy to.",
                      "items": {
                        "type": "object",
                        "properties": {
                          "clusterName": {
                            "type": "string"
                          },
                          "clusterGroup": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "provisionCluster": {
                      "type": "object",
                      "description": "Create a cluster for this instance rather than deploying to existing ones. The cluster is owned by the instance, so deleting the instance deletes it. An instance owns at most one cluster, and deploys only to that one.",
                      "properties": {
                        "enabled": {
                          "type": "boolean"
                        },
                        "name": {
                          "type": "string",
                          "description": "Defaults to the instance name."
                        }
                      }
                    }
                  }
                },
                "status": {
                  "type": "object",
                  "x-kubernetes-preserve-unknown-fields": true
                }
              }
            }
          }
        }
      ]
    }
  }
];
