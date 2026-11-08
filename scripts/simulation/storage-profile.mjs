export const STORAGE_PROFILE = Object.freeze({
    Virtio: "virtio-v1",
    IdePio: "ide-pio-v1",
    VirtioBounce: "virtio-bounce-v1",
});
export const SCENARIO_DEVICE_ENV = "ARTGOD_SCENARIO_DEVICE";
export const VIRTIO_ACCESS_PLATFORM_BIT = 33;

/** Storage is part of the replay hardware contract, not a tuning option. */
export function storageProfile(value) {
    if (value === STORAGE_PROFILE.Virtio)
        return {
            rootDevice: "/dev/vda",
            scenarioDevice: "/dev/vdb",
            rootController: "virtio-blk-pci,drive=replay-disk,ioeventfd=off",
            kernelOptions: [],
        };
    if (value === STORAGE_PROFILE.IdePio)
        return {
            rootDevice: "/dev/sda",
            scenarioDevice: "/dev/vda",
            rootController: "ide-hd,drive=replay-disk,bus=ide.0,unit=0",
            kernelOptions: ["libata.dma=0"],
        };
    if (value === STORAGE_PROFILE.VirtioBounce) {
        const virtio = storageProfile(STORAGE_PROFILE.Virtio);
        // ACCESS_PLATFORM selects Linux's DMA API. Forced SWIOTLB mappings copy
        // mutable pages before submission, isolating host AIO from later writes.
        return {
            ...virtio,
            rootController: `${virtio.rootController},iommu_platform=on,disable-legacy=on`,
            kernelOptions: ["iommu=soft", "swiotlb=force"],
        };
    }
    throw new Error(
        "An explicit supported simulation storageProfile is required",
    );
}
