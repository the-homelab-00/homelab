for resource in cephblockpools cephclusters cephfilesystems cephfilesystemsubvolumegroups cephobjectstores cephclients cephbucketnotifications cephbuckettopics cephfilesystemmirrors cephnfses cephobjectrealms cephobjectstoreusers cephobjectzonegroups cephobjectzones cephrbdmirrors; do
    kubectl delete $resource --all -n rook-ceph --grace-period=0 --force
done
